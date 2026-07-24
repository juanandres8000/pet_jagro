import { readToken, writeToken, clearToken, type StoredToken } from './tokenStore';

/**
 * Cliente de la API de HGINet (ApiRest) para Pet Jagro.
 *
 * Contrato (validado, no re-descubrir):
 *  - Auth:  GET {BASE}/Api/Autenticar/?usuario=&clave=&cod_compania=&cod_empresa=
 *           → { JwtToken, PasswordExpiration, Error }
 *  - Datos: GET {BASE}/Api/{Recurso}/{Metodo}/   con header Authorization: Bearer {JwtToken}
 *
 * Reglas NO obvias:
 *  - Rutas case-sensitive: /Api/ con A mayúscula. /api/ NO emite token.
 *  - HGINet permite UN SOLO token vigente por usuario. Re-autenticar con uno
 *    vigente devuelve Error "El Token aún se encuentra vigente...". Por eso el
 *    token se comparte vía Neon (ver tokenStore) y se reusa hasta vencer.
 *  - HGINet responde 200 incluso en errores lógicos: el fallo viene en un
 *    objeto { Error: { Codigo, Mensaje, Fecha } } dentro del body.
 */

const AUTH_TIMEOUT_MS = 10_000;
const REQ_TIMEOUT_MS = 15_000;
// Margen de seguridad: si al token le quedan menos de esto, lo renovamos.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

// ---- Tipos ----

interface HgiErrorPayload {
  Codigo?: number;
  Mensaje?: string;
  Fecha?: string;
}

/** Excepción tipada para errores devueltos por HGINet. */
export class HgiError extends Error {
  readonly codigo?: number;
  readonly fecha?: string;
  readonly httpStatus?: number;

  constructor(payload: HgiErrorPayload, httpStatus?: number) {
    super(payload.Mensaje || 'Error de HGINet');
    this.name = 'HgiError';
    this.codigo = payload.Codigo;
    this.fecha = payload.Fecha;
    this.httpStatus = httpStatus;
  }
}

interface AutenticacionRespuesta {
  JwtToken: string | null;
  PasswordExpiration?: string;
  Error?: HgiErrorPayload | null;
}

// ---- Config desde entorno (nunca hardcodear) ----

interface HgiConfig {
  baseUrl: string;
  usuario: string;
  clave: string;
  codCompania: string;
  codEmpresa: string;
}

function getConfig(): HgiConfig {
  const raw: Record<keyof HgiConfig, string | undefined> = {
    baseUrl: process.env.HGI_BASE_URL,
    usuario: process.env.HGI_USUARIO,
    clave: process.env.HGI_CLAVE,
    codCompania: process.env.HGI_COD_COMPANIA,
    codEmpresa: process.env.HGI_COD_EMPRESA,
  };
  for (const [k, v] of Object.entries(raw)) {
    if (!v) throw new Error(`Falta variable de entorno HGI para "${k}"`);
  }
  return {
    // baseUrl sin slash final para concatenar rutas de forma predecible.
    baseUrl: raw.baseUrl!.replace(/\/+$/, ''),
    usuario: raw.usuario!,
    clave: raw.clave!,
    codCompania: raw.codCompania!,
    codEmpresa: raw.codEmpresa!,
  };
}

// ---- Utilidades ----

// Colombia es UTC-5 permanente (sin horario de verano).
const HGI_TZ_OFFSET = '-05:00';
// Cotas de cordura para PasswordExpiration.
const FALLBACK_TTL_MS = 15 * 60 * 1000; // si no parsea
const MAX_TTL_MS = 12 * 60 * 60 * 1000; // techo defensivo
const MIN_TTL_MS = 60 * 1000; // piso

/**
 * Determina hasta cuándo confiar en el token, a partir de PasswordExpiration.
 *
 * PasswordExpiration es la vida de sesión que declara HGINet (varía: visto +20min
 * y +2h). Es la fuente correcta — el claim `exp` del JWT sobreestima (~5.8h) y no
 * refleja el rechazo real. Viene SIN zona horaria, en hora de Colombia (UTC-5).
 *
 * IMPORTANTE: no se acorta artificialmente. Acortarlo provocaba que nuestro reloj
 * marcara "vencido" mientras HGINet aún lo tenía vigente → re-auth → candado →
 * deadlock. El path de 401 (re-auth + reintento) cubre el caso de muerte temprana.
 */
function tokenExpiry(passwordExpiration?: string): Date {
  const now = Date.now();
  if (passwordExpiration) {
    const clean = passwordExpiration.replace(/(\.\d{3})\d+$/, '$1');
    const pwMs = Date.parse(`${clean}${HGI_TZ_OFFSET}`);
    if (Number.isFinite(pwMs) && pwMs > now) {
      // Acotar a [now+1min, now+12h] por defensa ante valores absurdos.
      return new Date(Math.min(pwMs, now + MAX_TTL_MS));
    }
  }
  return new Date(now + Math.max(FALLBACK_TTL_MS, MIN_TTL_MS));
}

/** Enmascara usuario/clave de una URL antes de loguear (la clave va en query). */
function maskAuthUrl(url: string): string {
  return url
    .replace(/(usuario=)[^&]*/i, '$1***')
    .replace(/(clave=)[^&]*/i, '$1***');
}

function isHgiErrorPayload(x: unknown): x is HgiErrorPayload {
  return (
    !!x &&
    typeof x === 'object' &&
    ('Codigo' in x || 'Mensaje' in x) &&
    typeof (x as HgiErrorPayload).Mensaje !== 'undefined'
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // cache: 'no-store' obligatorio: Next.js cachea fetch por defecto. Sin esto,
    // las respuestas de HGINet (auth y datos) se servirían obsoletas.
    return await fetch(url, { ...init, cache: 'no-store', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- L1: caché en memoria dentro del mismo lambda ----
let memoryToken: StoredToken | null = null;

function memValid(): StoredToken | null {
  if (memoryToken && memoryToken.expiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS) {
    return memoryToken;
  }
  return null;
}

// ---- Autenticación ----

/**
 * Llama a /Api/Autenticar y guarda el token en Neon + memoria.
 * Devuelve el token nuevo, o null si HGINet rechazó por candado de token vigente.
 */
async function authenticate(): Promise<StoredToken | null> {
  const cfg = getConfig();
  const qs = new URLSearchParams({
    usuario: cfg.usuario,
    clave: cfg.clave,
    cod_compania: cfg.codCompania,
    cod_empresa: cfg.codEmpresa,
  }).toString();
  // Ruta case-sensitive: /Api/ con mayúscula.
  const url = `${cfg.baseUrl}/Api/Autenticar/?${qs}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json' } }, AUTH_TIMEOUT_MS);
  } catch (err) {
    // Nunca logueamos la URL completa (la clave va en query string).
    console.error(`[hgi] fallo de red en Autenticar ${maskAuthUrl(url)}:`, (err as Error).message);
    throw new Error('No se pudo contactar a HGINet para autenticar');
  }

  const data = (await res.json().catch(() => null)) as AutenticacionRespuesta | null;

  if (data?.JwtToken) {
    const jwt = data.JwtToken;
    const expiresAt = tokenExpiry(data.PasswordExpiration);
    await writeToken(jwt, expiresAt);
    memoryToken = { jwt, expiresAt };
    return memoryToken;
  }

  // Candado: otra invocación ya tiene un token vigente.
  const mensaje = data?.Error?.Mensaje || '';
  if (/token a[uú]n se encuentra vigente/i.test(mensaje)) {
    return null;
  }

  // Otro error (credenciales, licencia, compañía...).
  if (data?.Error) throw new HgiError(data.Error, res.status);
  throw new Error(`Autenticación HGINet inesperada (HTTP ${res.status})`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Devuelve un JWT válido, renovándolo si hace falta.
 * Orden: L1 memoria → Neon → autenticar (con manejo del candado).
 */
export async function getValidToken(): Promise<string> {
  // a) L1 en memoria
  const mem = memValid();
  if (mem) return mem.jwt;

  // a) Neon
  const cached = await readToken();
  if (cached && cached.expiresAt.getTime() - Date.now() > EXPIRY_SKEW_MS) {
    memoryToken = cached;
    return cached.jwt;
  }

  // b) Renovar
  const fresh = await authenticate();
  if (fresh) return fresh.jwt;

  // c) Candado: HGINet dice que hay un token vigente y rehúsa emitir otro.
  //    El token que tenemos cacheado ES ese vigente (o uno que otra invocación
  //    acaba de escribir). Lo usamos AUNQUE nuestro reloj lo crea vencido: HGINet
  //    afirma que sigue válido, y si estuviera muerto el path de 401 lo recupera.
  //    Solo gateamos en que exista un JWT (no en su expiración local).
  const reread = await readToken();
  if (reread) {
    memoryToken = reread;
    return reread.jwt;
  }

  // Esperar 1s y reintentar la relectura una vez (carrera entre lambdas).
  await sleep(1000);
  const retry = await readToken();
  if (retry) {
    memoryToken = retry;
    return retry.jwt;
  }

  throw new Error(
    'HGINet reporta un token vigente para el usuario pero no está en caché (Neon). ' +
      'Otro sistema retiene el token; esperar a que expire o liberarlo.',
  );
}

// ---- Llamadas a recursos ----

export interface HgiGetParams {
  [key: string]: string | number | boolean | undefined;
}

/**
 * GET genérico a un recurso de HGINet.
 * Construye {BASE}/Api/{recurso}/{metodo}/ (case-sensitive) con query params,
 * adjunta el Bearer, detecta el objeto Error de HGINet y reintenta una vez ante
 * token caducado: 401, o 400 con cuerpo vacío (otra cara del mismo fallo).
 */
export async function hgiGet<T = unknown>(
  recurso: string,
  metodo: string,
  params: HgiGetParams = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return hgiGetInternal<T>(recurso, metodo, params, false, opts.timeoutMs ?? REQ_TIMEOUT_MS);
}

async function hgiGetInternal<T>(
  recurso: string,
  metodo: string,
  params: HgiGetParams,
  isRetry: boolean,
  timeoutMs: number = REQ_TIMEOUT_MS,
): Promise<T> {
  const cfg = getConfig();
  const token = await getValidToken();

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.append(k, String(v));
  }
  const query = qs.toString();
  // Ruta case-sensitive con /Api/ y barra final.
  const url = `${cfg.baseUrl}/Api/${recurso}/${metodo}/${query ? `?${query}` : ''}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
      timeoutMs,
    );
  } catch (err) {
    console.error(`[hgi] fallo de red en ${recurso}/${metodo}:`, (err as Error).message);
    throw new Error(`No se pudo contactar a HGINet (${recurso}/${metodo})`);
  }

  // Token expiró server-side: invalidar caché, re-autenticar y reintentar UNA vez.
  if (res.status === 401 && !isRetry) {
    await clearToken();
    memoryToken = null;
    return hgiGetInternal<T>(recurso, metodo, params, true, timeoutMs);
  }

  // Se lee el cuerpo como texto (una sola vez) para distinguir dos clases de 400:
  // el de token caducado y el de error real.
  const rawBody = await res.text();

  // HGINet responde 400 con CUERPO VACÍO cuando el token caducó server-side
  // (síntoma distinto del 401, pero misma causa: el token dejó de valer). Se le
  // da el mismo trato que al 401: invalidar caché, re-autenticar y reintentar UNA
  // vez. Un 400 CON cuerpo (objeto de error de HGINet) es un fallo genuino y NO
  // entra aquí: cae al manejo normal de más abajo.
  if (res.status === 400 && rawBody.trim() === '' && !isRetry) {
    await clearToken();
    memoryToken = null;
    return hgiGetInternal<T>(recurso, metodo, params, true, timeoutMs);
  }

  let data: unknown = null;
  if (rawBody) {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = null;
    }
  }

  // Error lógico de HGINet (viene con HTTP 200 y objeto Error).
  // HGINet marca sus errores con $type "...Error.Error..." y/o un campo Error anidado.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as { Error?: unknown; $type?: unknown };
    if (isHgiErrorPayload(obj.Error)) {
      throw new HgiError(obj.Error, res.status);
    }
    if (typeof obj.$type === 'string' && /\.Error\.Error/.test(obj.$type) && isHgiErrorPayload(obj)) {
      throw new HgiError(obj as HgiErrorPayload, res.status);
    }
  }

  if (!res.ok) {
    throw new Error(`HGINet ${recurso}/${metodo} devolvió HTTP ${res.status}`);
  }

  return data as T;
}
