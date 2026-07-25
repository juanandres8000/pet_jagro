/**
 * Mapper: Api/Cartera/ResumenPorClases → composición de cartera por clase.
 *
 * ================== DOS REGLAS QUE NO SE PUEDEN TOCAR ==================
 *
 * 1. `Saldo` es un SALDO, NO UN FLUJO. **Nunca se suma entre periodos.**
 *    Por eso el builder llama UNA vez con `periodo=*` y deja que el ERP
 *    consolide: la cifra que devuelve ya es el saldo del año.
 *    Medido en vivo: periodo=06 → 772 filas; periodo=05 → 762; periodo=* → 1.271.
 *    Si fuera aditivo, el año daría ~9.240 filas (12 × 770). No lo es: son
 *    combinaciones distintas de (clase, tercero, banco), y el mismo tercero
 *    aparece en varios periodos con su saldo, no con su movimiento.
 *    Iterar los 12 periodos y sumar multiplicaría la cartera por ~12.
 *    Es EXACTAMENTE el bug que alguien reintroduce en seis meses "para tener
 *    la serie mensual". Si hace falta serie temporal, no es este endpoint.
 *
 * 2. Los saldos NEGATIVOS son reales y se muestran. No se filtran, no se
 *    vuelven cero, no se pasan por Math.abs. Son anticipos y notas crédito a
 *    favor del tercero (visto: −26.963). Un gráfico que no soporte negativos se
 *    cambia por uno que sí — nunca se recorta el dato para que quepa.
 *    Por eso el gráfico de la vista tiene línea base en cero y barras a ambos
 *    lados, y los totales usan sumas con signo.
 *
 * ======================================================================
 *
 * Nota sobre `tipo_cartera`: sólo el 0 (General) trae datos en esta instancia;
 * 1 (Cuotas) y 3 (Tipo) devuelven 0 filas. El builder fija 0 y la vista NO
 * expone selector: sería un control muerto.
 */

export interface HgiResumenClase {
  CodigoClase?: string | number;
  NombreClase?: string;
  Tercero?: string | number;
  NombreTercero?: string;
  CodigoBanco?: string | number;
  NombreBanco?: string;
  Saldo?: number | string;
  [key: string]: unknown;
}

/** Fila por (clase, tercero, banco) tal como la devuelve el ERP. */
export interface ClaseSaldo {
  codigoClase: string;
  nombreClase: string;
  tercero: string;
  nombreTercero: string;
  codigoBanco: string;
  nombreBanco: string;
  saldo: number; // con signo: puede ser negativo
}

/** Agregado por clase (o por banco): saldo con signo + composición. */
export interface GrupoSaldo {
  codigo: string;
  nombre: string;
  saldo: number; // suma CON SIGNO, nunca absoluta
  terceros: number;
  /** Cuántas filas del grupo están en negativo (anticipos / notas a favor). */
  enNegativo: number;
  /** Saldo de las filas positivas y de las negativas, por separado. */
  saldoPositivo: number;
  saldoNegativo: number;
}

export interface ClasesResumen {
  anyo: number;
  porClase: GrupoSaldo[];
  porBanco: GrupoSaldo[];
  totalSaldo: number;
  totalPositivo: number;
  totalNegativo: number;
  terceros: number;
  filas: number;
  /** false si el ERP no discrimina banco (un único valor comodín). */
  bancoDiscrimina: boolean;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** Mapea una fila cruda. Descarta la que no tenga tercero (no es agrupable). */
export function toClaseSaldo(r: HgiResumenClase): ClaseSaldo | null {
  const tercero = str(r.Tercero);
  if (!tercero) return null;
  const codigoClase = str(r.CodigoClase);
  const codigoBanco = str(r.CodigoBanco);
  return {
    codigoClase,
    // El ERP sí puebla NombreClase y NombreBanco aquí (a diferencia de
    // ObtenerRecaudoPorVendedor, donde las descripciones llegan null).
    // Aun así se cae al código antes que inventar un nombre.
    nombreClase: str(r.NombreClase) || codigoClase || '(sin clase)',
    tercero,
    nombreTercero: str(r.NombreTercero) || tercero,
    codigoBanco,
    nombreBanco: str(r.NombreBanco) || codigoBanco || '(sin banco)',
    saldo: num(r.Saldo),
  };
}

export function mapResumenClases(raw: unknown): ClaseSaldo[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaseSaldo[] = [];
  for (const r of raw as HgiResumenClase[]) {
    if (!r || typeof r !== 'object') continue;
    const f = toClaseSaldo(r);
    if (f) out.push(f);
  }
  return out;
}

/** Agrupa por una clave conservando el SIGNO de los saldos. */
function agrupar(
  filas: ClaseSaldo[],
  codigo: (f: ClaseSaldo) => string,
  nombre: (f: ClaseSaldo) => string,
): GrupoSaldo[] {
  const m = new Map<
    string,
    { nombre: string; saldo: number; pos: number; neg: number; enNegativo: number; terceros: Set<string> }
  >();
  for (const f of filas) {
    const k = codigo(f);
    const e = m.get(k) ?? { nombre: nombre(f), saldo: 0, pos: 0, neg: 0, enNegativo: 0, terceros: new Set<string>() };
    e.saldo += f.saldo; // CON signo
    if (f.saldo < 0) {
      e.neg += f.saldo;
      e.enNegativo += 1;
    } else {
      e.pos += f.saldo;
    }
    e.terceros.add(f.tercero);
    m.set(k, e);
  }
  return [...m]
    .map(([codigo, e]) => ({
      codigo,
      nombre: e.nombre,
      saldo: e.saldo,
      terceros: e.terceros.size,
      enNegativo: e.enNegativo,
      saldoPositivo: e.pos,
      saldoNegativo: e.neg,
    }))
    // Orden por saldo descendente; los negativos caen al final por sí solos.
    .sort((a, b) => b.saldo - a.saldo);
}

export function aggregateClases(filas: ClaseSaldo[], anyo: number): ClasesResumen {
  const porClase = agrupar(filas, (f) => f.codigoClase, (f) => f.nombreClase);
  const porBanco = agrupar(filas, (f) => f.codigoBanco, (f) => f.nombreBanco);

  let totalSaldo = 0;
  let totalPositivo = 0;
  let totalNegativo = 0;
  const terceros = new Set<string>();
  for (const f of filas) {
    totalSaldo += f.saldo;
    if (f.saldo < 0) totalNegativo += f.saldo;
    else totalPositivo += f.saldo;
    terceros.add(f.tercero);
  }

  return {
    anyo,
    porClase,
    porBanco,
    totalSaldo,
    totalPositivo,
    totalNegativo,
    terceros: terceros.size,
    filas: filas.length,
    // Con un solo banco el corte no informa nada y la vista lo omite.
    bancoDiscrimina: porBanco.length > 1,
  };
}
