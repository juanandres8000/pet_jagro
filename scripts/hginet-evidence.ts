/**
 * SCRIPT ONE-OFF — reporte de evidencia técnica para el soporte de HGINet.
 *
 * Ejecuta contra HGINet real los endpoints que hoy fallan o devuelven datos
 * incompletos y guarda la evidencia CRUDA: URL completa, headers enviados,
 * params, status HTTP y el body EXACTAMENTE como llegó, sin parsear ni
 * transformar. Salida en `evidencia-hginet.json` (máquina) y
 * `evidencia-hginet.md` (para adjuntar al ticket).
 *
 * ══ SÓLO LECTURA ══════════════════════════════════════════════════════════
 * Todas las llamadas son GET de consulta. Por defecto el script NO se
 * autentica: reutiliza el token cacheado en la fila compartida `hgi_token`
 * (Supabase) vía `readToken()`, que es un SELECT. No escribe en HGINet, no
 * escribe en la BD y no invalida el token de producción.
 *
 * Con `--auth` sí usa `getValidToken()` de lib/hgi/client — el flujo completo,
 * idéntico al de la app: memoria → store → /Api/Autenticar. Eso PUEDE escribir
 * la fila `hgi_token` (es el flujo normal y compartido con producción, pero es
 * una escritura). Requiere HGI_USUARIO / HGI_CLAVE / HGI_COD_COMPANIA /
 * HGI_COD_EMPRESA, que viven sólo en Vercel. Úsalo únicamente si el token
 * cacheado ya no lo acepta HGINet (401 en todos los casos).
 *
 * ══ CÓMO CORRERLO ═════════════════════════════════════════════════════════
 *   node --env-file=.env.local --import ./scripts/ts-resolve.mjs \
 *        scripts/hginet-evidence.ts [--auth] [--anyo=2026] [--periodo=6]
 *        [--tercero=900323135] [--empresa=1] [--solo=pyg|cartera]
 *
 * ══ AVISO DE SEGURIDAD ════════════════════════════════════════════════════
 * El payload del JWT que emite HGINet trae `usuario` y `clave` EN CLARO
 * (base64url, decodificable por cualquiera que vea el token). Por eso aquí el
 * Authorization se trunca siempre y el JWT completo NO se escribe en ninguno de
 * los dos archivos de salida. Al adjuntarlos al ticket no hay credenciales.
 */

import { readToken } from '../lib/hgi/tokenStore';
import { getValidToken } from '../lib/hgi/client';
import { writeFileSync } from 'node:fs';

// ---------------------------------------------------------------- CLI ------

const flags = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags.set(m[1], m[2] ?? 'true');
}
const FLAG_AUTH = flags.get('auth') === 'true';
const SOLO = flags.get('solo'); // 'pyg' | 'cartera' | undefined (todo)

// Timeout amplio: DocumentosContables de un mes cerrado puede ser lento.
const TIMEOUT_MS = Number(flags.get('timeout') ?? 120_000);
// En el .md el body se recorta para que el archivo siga siendo legible; el
// body ÍNTEGRO está siempre en el .json.
const MD_BODY_MAX = Number(flags.get('mdmax') ?? 20_000);

const OUT_JSON = 'evidencia-hginet.json';
const OUT_MD = 'evidencia-hginet.md';

// ------------------------------------------------------------- tipos ------

interface Caso {
  id: string;
  grupo: string;
  recurso: string;
  metodo: string;
  /** ORDEN EXACTO: el routing de WebAPI de HGINet es por firma, no por nombre. */
  params: Record<string, string>;
  /** Qué se espera y por qué este caso está en el reporte. */
  sintoma: string;
}

interface Evidencia {
  id: string;
  grupo: string;
  sintoma: string;
  request: {
    metodoHttp: 'GET';
    ruta: string;
    urlCompleta: string; // enmascarada (clave/usuario), ver maskUrl
    params: Record<string, string>;
    headers: Record<string, string>; // Authorization truncado
    timestampEnvio: string;
  };
  respuesta: {
    httpStatus: number | null;
    httpStatusText: string | null;
    headers: Record<string, string> | null;
    /** Body TAL CUAL llegó. Sin parsear, sin recortar, sin normalizar. */
    bodyRaw: string | null;
    timestampRecepcion: string | null;
    duracionMs: number;
    /** Sólo si la petición ni siquiera llegó a completarse (red/timeout). */
    errorRed?: string;
  };
  /**
   * Derivado NUESTRO para poder indexar el reporte (conteo de filas, bytes).
   * NO es evidencia y no sustituye a `bodyRaw` — el soporte debe leer el raw.
   */
  indice: { bytes: number; esArray: boolean | null; filas: number | null };
}

// --------------------------------------------------------- utilidades -----

/** Enmascara credenciales en la query string (la clave viaja en /Api/Autenticar). */
function maskUrl(url: string): string {
  return url.replace(/(clave=)[^&]*/i, '$1***').replace(/(usuario=)[^&]*/i, '$1***');
}

/** Authorization recortado: ni el .json ni el .md deben llevar el JWT entero. */
function truncBearer(jwt: string): string {
  return `Bearer ${jwt.slice(0, 8)}…${jwt.slice(-6)} (JWT de ${jwt.length} chars, truncado a propósito)`;
}

/** Lee un claim del JWT sin volcar el resto (el payload trae la clave en claro). */
function claim(jwt: string, nombre: string): string | undefined {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
    const v = p[nombre];
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

function baseUrl(): string {
  const b = process.env.HGI_BASE_URL;
  if (!b) throw new Error('Falta HGI_BASE_URL en el entorno');
  return b.replace(/\/+$/, '');
}

/** Misma construcción de URL que lib/hgi/client.ts: /Api/{recurso}/{metodo}/?qs */
function construirUrl(recurso: string, metodo: string, params: Record<string, string>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.append(k, v);
  const query = qs.toString();
  return `${baseUrl()}/Api/${recurso}/${metodo}/${query ? `?${query}` : ''}`;
}

// -------------------------------------------------------- ejecución -------

async function ejecutar(caso: Caso, jwt: string): Promise<Evidencia> {
  const url = construirUrl(caso.recurso, caso.metodo, caso.params);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${jwt}`,
  };
  const headersReporte = { ...headers, Authorization: truncBearer(jwt) };

  const envio = new Date();
  const t0 = Date.now();

  const base: Omit<Evidencia, 'respuesta' | 'indice'> = {
    id: caso.id,
    grupo: caso.grupo,
    sintoma: caso.sintoma,
    request: {
      metodoHttp: 'GET',
      ruta: `Api/${caso.recurso}/${caso.metodo}/`,
      urlCompleta: maskUrl(url),
      params: caso.params,
      headers: headersReporte,
      timestampEnvio: envio.toISOString(),
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // cache: 'no-store' por coherencia con lib/hgi/client.ts.
    const res = await fetch(url, { method: 'GET', headers, cache: 'no-store', signal: ctrl.signal });
    // .text() y NADA más: el body se guarda byte a byte como llegó.
    const bodyRaw = await res.text();
    const duracionMs = Date.now() - t0;

    // Índice (derivado, no evidencia). Si no parsea, se deja en null y ya.
    let esArray: boolean | null = null;
    let filas: number | null = null;
    try {
      const p = JSON.parse(bodyRaw) as unknown;
      esArray = Array.isArray(p);
      filas = Array.isArray(p) ? p.length : null;
    } catch {
      /* body no-JSON: el raw manda */
    }

    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    return {
      ...base,
      respuesta: {
        httpStatus: res.status,
        httpStatusText: res.statusText,
        headers: resHeaders,
        bodyRaw,
        timestampRecepcion: new Date().toISOString(),
        duracionMs,
      },
      indice: { bytes: Buffer.byteLength(bodyRaw), esArray, filas },
    };
  } catch (err) {
    return {
      ...base,
      respuesta: {
        httpStatus: null,
        httpStatusText: null,
        headers: null,
        bodyRaw: null,
        timestampRecepcion: new Date().toISOString(),
        duracionMs: Date.now() - t0,
        errorRed: (err as Error).message,
      },
      indice: { bytes: 0, esArray: null, filas: null },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------- casos ------

function construirCasos(empresa: string, anyo: string, periodo: string, tercero: string): Caso[] {
  // Firma documentada de DocumentosContables/Obtener, en su orden exacto.
  // Con la convención codigo_* (codigo_empresa, …) responde 404.
  const rangoContable = (desde: string, hasta: string) => ({
    empresa,
    comprobante: '*',
    documento: '*',
    fecha_inicial: desde,
    fecha_final: hasta,
  });

  // Firma de Cartera/ResumenPorClases (misma que usa lib/hgi/clases.ts).
  const clases = (tipoCartera: string) => ({
    anyo,
    periodo,
    codigo_tercero: tercero,
    codigo_local: '*',
    tipo_cartera: tipoCartera,
    grupo: '*',
  });

  const pyg: Caso[] = [
    {
      id: 'pyg-01-plan-niif',
      grupo: 'P&G / permisos',
      recurso: 'PlanContable',
      metodo: 'ObtenerNIIF',
      params: { codigo: '*' },
      sintoma:
        'El plan de cuentas NIIF es el primer insumo del módulo de P&G que estamos construyendo. La ruta existe y la firma es la correcta (ver controles 6 y 7), pero la respuesta es un 409 de permisos.',
    },
    {
      id: 'pyg-02-plan-pcga',
      grupo: 'P&G / permisos',
      recurso: 'PlanContable',
      metodo: 'ObtenerPCGA',
      params: { codigo: '*' },
      sintoma: 'Mismo caso que el anterior, sobre el plan de cuentas PCGA.',
    },
    {
      id: 'pyg-03-docs-1dia',
      grupo: 'P&G / permisos',
      recurso: 'DocumentosContables',
      metodo: 'Obtener',
      params: rangoContable('2026-06-01', '2026-06-01'),
      sintoma:
        'Movimiento contable (débito/crédito) de UN solo día — el rango más pequeño posible, para dejar descartado que el fallo sea por volumen o por timeout.',
    },
    {
      id: 'pyg-04-docs-mes',
      grupo: 'P&G / permisos',
      recurso: 'DocumentosContables',
      metodo: 'Obtener',
      params: rangoContable('2026-06-01', '2026-06-30'),
      sintoma: 'El mismo endpoint sobre un mes cerrado completo, que es el uso real que necesita el módulo de P&G.',
    },
    // ---- Controles. No son fallos a reportar: acotan el diagnóstico. ----
    {
      id: 'ctl-01-token-vivo',
      grupo: 'Control',
      recurso: 'TercerosTipo',
      metodo: 'Obtener',
      params: { codigo: '*' },
      sintoma:
        'CONTROL: endpoint que sí responde con datos, con EL MISMO token y en la MISMA corrida. Demuestra que el token es válido y que lo que falla es el permiso del endpoint, no la autenticación.',
    },
    {
      id: 'ctl-02-accion-inexistente',
      grupo: 'Control',
      recurso: 'PlanContable',
      metodo: 'ObtenerPlanContableNIIF',
      params: { codigo: '*' },
      sintoma:
        'CONTROL: nombre de acción que aparece en el manual pero no existe en esta instancia. ASP.NET responde "No action was found on the controller" — distinto de la respuesta de los casos de arriba, o sea que allí la acción SÍ existe.',
    },
    {
      id: 'ctl-03-controlador-inexistente',
      grupo: 'Control',
      recurso: 'PlanContableQueNoExiste',
      metodo: 'Obtener',
      params: { codigo: '*' },
      sintoma:
        'CONTROL: controlador inventado. ASP.NET responde "No type was found that matches the controller" — el tercer tipo de respuesta, para completar el oráculo (controlador ausente ≠ acción ausente ≠ sin permiso).',
    },
  ];

  const cartera: Caso[] = [
    {
      id: 'car-01-clases-tipo0',
      grupo: 'Cartera / datos incompletos',
      recurso: 'Cartera',
      metodo: 'ResumenPorClases',
      params: clases('0'),
      sintoma: `CONTROL del bloque: tipo_cartera=0 (General) sí devuelve filas para el tercero ${tercero}.`,
    },
    {
      id: 'car-02-clases-tipo1',
      grupo: 'Cartera / datos incompletos',
      recurso: 'Cartera',
      metodo: 'ResumenPorClases',
      params: clases('1'),
      sintoma:
        'tipo_cartera=1 (Cuotas) devuelve 0 filas con los mismos parámetros que el control. Queremos saber si la clasificación por cuotas no está configurada en esta instancia o si es un tema de permisos/parametrización.',
    },
    {
      id: 'car-03-clases-tipo3',
      grupo: 'Cartera / datos incompletos',
      recurso: 'Cartera',
      metodo: 'ResumenPorClases',
      params: clases('3'),
      sintoma: 'tipo_cartera=3 (Tipo) devuelve 0 filas. Misma pregunta que el caso anterior.',
    },
    {
      id: 'car-04-obtener-duplicados',
      grupo: 'Cartera / datos incompletos',
      recurso: 'Cartera',
      metodo: 'Obtener',
      // Firma de Cartera/Obtener (misma que usa lib/hgi/periodoVigente.ts).
      params: {
        anyo,
        periodo: '*',
        codigo_tercero: tercero,
        codigo_local: '*',
        tipo_cartera: '*',
        grupo: '*',
        codigo_clase: '*',
      },
      sintoma:
        `Acotado a UN tercero (${tercero}) para que el raw sea revisable a mano. Con periodo='*' el mismo documento vuelve en varias filas. ` +
        'Necesitamos que el soporte confirme QUÉ campo distingue esas filas (sospechamos Periodo) y si el campo Cuota debería venir poblado: en 2.474 filas medidas llega siempre vacío. ' +
        'De eso depende si el saldo total de cartera que calculamos está bien.',
    },
  ];

  if (SOLO === 'pyg') return pyg;
  if (SOLO === 'cartera') return cartera;
  return [...pyg, ...cartera];
}

/**
 * Lo que se le pide al soporte por cada grupo. Va arriba de cada bloque del .md
 * para que el ticket sea accionable; la evidencia cruda viene inmediatamente
 * debajo y es la que manda.
 */
const PEDIDOS: Record<string, string> = {
  'P&G / permisos':
    'Pedimos que se habiliten al usuario los permisos de `PlanContable` (`ObtenerNIIF` / `ObtenerPCGA`) y de ' +
    '`DocumentosContables/Obtener`. Los controles 6 y 7 muestran que ASP.NET distingue tres respuestas distintas — ' +
    'controlador inexistente, acción inexistente y 409 —, así que el 409 de los casos 1 a 4 no es una ruta mal escrita: ' +
    'las rutas existen y el ERP las está negando por permisos. El control 5 confirma que el token de la misma corrida es válido.',
  'Cartera / datos incompletos':
    'Pedimos dos confirmaciones: (a) si `tipo_cartera` 1 (Cuotas) y 3 (Tipo) devuelven `[]` porque esa clasificación no ' +
    'está parametrizada en esta instancia o porque falta un permiso; y (b) en `Cartera/Obtener` con `periodo=*`, qué campo ' +
    'distingue las filas que se repiten para el mismo documento y si `Cuota` debería llegar poblado. De (b) depende si el ' +
    'saldo total de cartera que calculamos es correcto.',
  Control: 'Estos casos no son fallos: acotan el diagnóstico de los anteriores.',
};

// ------------------------------------------------------------ salida ------

function renderMd(meta: Record<string, unknown>, evidencias: Evidencia[]): string {
  const L: string[] = [];
  L.push('# Evidencia técnica — API de HGINet');
  L.push('');
  L.push(`Generado: **${meta.generado}**`);
  L.push('');
  L.push('Todas las llamadas son **GET de consulta** ejecutadas contra la instancia productiva.');
  L.push('Los cuerpos de respuesta van **tal cual llegaron**: sin parsear, sin reordenar y sin limpiar.');
  L.push('');
  L.push('## Contexto de la conexión');
  L.push('');
  L.push('| Dato | Valor |');
  L.push('|---|---|');
  L.push(`| Base URL | \`${meta.baseUrl}\` |`);
  L.push(`| Usuario | \`${meta.usuario}\` |`);
  L.push(`| cod_compania | \`${meta.codCompania}\` |`);
  L.push(`| cod_empresa | \`${meta.codEmpresa}\` |`);
  L.push(`| Obtención del token | ${meta.origenToken} |`);
  L.push(`| URL de autenticación | \`${meta.urlAuth}\` |`);
  L.push('');
  L.push(
    'El `Authorization` de cada caso va truncado en este documento a propósito: el payload del JWT que emite ' +
      'HGINet incluye el usuario y la clave en claro, así que el token completo no se adjunta.',
  );
  L.push('');
  L.push('## Resumen');
  L.push('');
  L.push('| # | Caso | Ruta | HTTP | Filas | Bytes | ms |');
  L.push('|---|---|---|---|---|---|---|');
  evidencias.forEach((e, i) => {
    const r = e.respuesta;
    L.push(
      `| ${i + 1} | \`${e.id}\` | \`${e.request.ruta}\` | ${r.httpStatus ?? `— (${r.errorRed ?? 'sin respuesta'})`} | ` +
        `${e.indice.filas ?? '—'} | ${e.indice.bytes} | ${r.duracionMs} |`,
    );
  });
  L.push('');

  let grupoActual = '';
  evidencias.forEach((e, i) => {
    if (e.grupo !== grupoActual) {
      grupoActual = e.grupo;
      L.push('');
      L.push(`## ${grupoActual}`);
      if (PEDIDOS[grupoActual]) {
        L.push('');
        L.push(PEDIDOS[grupoActual]);
      }
    }
    L.push('');
    L.push(`### ${i + 1}. \`${e.id}\` — \`${e.request.ruta}\``);
    L.push('');
    L.push(e.sintoma);
    L.push('');
    L.push('**Petición**');
    L.push('');
    L.push('```http');
    L.push(`${e.request.metodoHttp} ${e.request.urlCompleta}`);
    for (const [k, v] of Object.entries(e.request.headers)) L.push(`${k}: ${v}`);
    L.push('```');
    L.push('');
    L.push('**Parámetros** (en el orden exacto en que se envían)');
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(e.request.params, null, 2));
    L.push('```');
    L.push('');
    L.push(`**Enviada**: \`${e.request.timestampEnvio}\` · **Recibida**: \`${e.respuesta.timestampRecepcion}\` · **Duración**: ${e.respuesta.duracionMs} ms`);
    L.push('');
    if (e.respuesta.errorRed) {
      L.push('**Respuesta**: la petición no llegó a completarse.');
      L.push('');
      L.push('```');
      L.push(e.respuesta.errorRed);
      L.push('```');
      return;
    }
    // statusText llega vacío sobre HTTP/2; sin el trim quedaría `409 ` con un espacio colgando.
    const estado = `${e.respuesta.httpStatus} ${e.respuesta.httpStatusText ?? ''}`.trim();
    L.push(`**Respuesta** — HTTP \`${estado}\``);
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(e.respuesta.headers, null, 2));
    L.push('```');
    L.push('');
    const body = e.respuesta.bodyRaw ?? '';
    const recortado = body.length > MD_BODY_MAX;
    L.push(
      `**Cuerpo de la respuesta, sin modificar** (${Buffer.byteLength(body)} bytes)` +
        (recortado ? ` — aquí van los primeros ${MD_BODY_MAX} caracteres; el cuerpo íntegro está en \`${OUT_JSON}\`` : ''),
    );
    L.push('');
    L.push('```');
    L.push(body === '' ? '(cuerpo vacío)' : recortado ? body.slice(0, MD_BODY_MAX) : body);
    L.push('```');
  });

  L.push('');
  L.push('---');
  L.push('');
  L.push(
    `Generado por \`scripts/hginet-evidence.ts\`. El JSON equivalente, con los cuerpos completos, está en \`${OUT_JSON}\`.`,
  );
  L.push('');
  return L.join('\n');
}

// -------------------------------------------------------------- main ------

async function main() {
  let jwt: string;
  let origenToken: string;

  if (FLAG_AUTH) {
    // Flujo completo de lib/hgi/client: memoria → store → /Api/Autenticar.
    jwt = await getValidToken();
    origenToken = '`getValidToken()` de `lib/hgi/client` (flujo completo, puede re-autenticar)';
  } else {
    const t = await readToken();
    if (!t) {
      console.error(
        'No hay token en la fila compartida `hgi_token` y el script corre en modo sólo-lectura.\n' +
          'Volvé a correrlo con --auth (requiere HGI_USUARIO / HGI_CLAVE / HGI_COD_COMPANIA / HGI_COD_EMPRESA).',
      );
      process.exit(1);
    }
    jwt = t.jwt;
    const restanMin = Math.round((t.expiresAt.getTime() - Date.now()) / 60_000);
    origenToken =
      'reutilizado de la fila compartida `hgi_token` (Supabase), **sin re-autenticar** — ' +
      `vencimiento estimado local: ${t.expiresAt.toISOString()} (${restanMin} min)`;
  }

  // cod_empresa / cod_compania: del entorno si están; si no, del propio token.
  // Se leen SÓLO esos dos claims — el payload del JWT trae también la clave.
  const codEmpresa = flags.get('empresa') ?? process.env.HGI_COD_EMPRESA ?? claim(jwt, 'cod_empresa') ?? '';
  const codCompania = process.env.HGI_COD_COMPANIA ?? claim(jwt, 'cod_compania') ?? '';
  const usuario = process.env.HGI_USUARIO ?? claim(jwt, 'usuario') ?? '(desconocido)';

  const anyo = flags.get('anyo') ?? '2026';
  const periodo = flags.get('periodo') ?? '6';
  const tercero = flags.get('tercero') ?? '900323135';

  if (!codEmpresa) {
    console.error('No se pudo determinar cod_empresa. Pasalo con --empresa=<codigo>.');
    process.exit(1);
  }

  const casos = construirCasos(codEmpresa, anyo, periodo, tercero);
  console.log(`Ejecutando ${casos.length} casos contra ${baseUrl()} …\n`);

  const evidencias: Evidencia[] = [];
  // En serie a propósito: no hay ninguna razón para golpear el ERP en paralelo.
  for (const caso of casos) {
    process.stdout.write(`  · ${caso.id.padEnd(30)} `);
    const ev = await ejecutar(caso, jwt);
    evidencias.push(ev);
    const r = ev.respuesta;
    console.log(
      r.errorRed
        ? `ERROR DE RED (${r.errorRed})`
        : `HTTP ${r.httpStatus} · ${ev.indice.filas ?? '—'} filas · ${ev.indice.bytes} bytes · ${r.duracionMs} ms`,
    );
  }

  const meta = {
    generado: new Date().toISOString(),
    baseUrl: baseUrl(),
    usuario,
    codCompania,
    codEmpresa,
    origenToken,
    // La clave real nunca sale de aquí: la URL de auth va enmascarada.
    urlAuth: maskUrl(
      `${baseUrl()}/Api/Autenticar/?usuario=${usuario}&clave=SECRETO&cod_compania=${codCompania}&cod_empresa=${codEmpresa}`,
    ),
    nota:
      'Los cuerpos en `respuesta.bodyRaw` están tal cual los devolvió HGINet. ' +
      'El bloque `indice` es un derivado nuestro para indexar el reporte, no es evidencia.',
  };

  writeFileSync(OUT_JSON, `${JSON.stringify({ meta, evidencias }, null, 2)}\n`, 'utf8');
  writeFileSync(OUT_MD, renderMd(meta, evidencias), 'utf8');
  console.log(`\nEscritos ${OUT_JSON} y ${OUT_MD}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
