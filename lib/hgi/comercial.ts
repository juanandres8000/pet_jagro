import { NIT_MOSTRADOR_GENERICO, type VentaPorZona } from './mappers/ventas';
import { ZONA_TODAS, ordenZona, esPorZonaVendedor } from './zonas';

/**
 * Agregados por zona comercial compartidos por /api/gerencia y /api/comercial:
 * el pareto de clientes por zona y su forma de respuesta (resumen / detalle).
 * Se calculan sobre los por_zona mensuales de hgi_ventas_mensual.
 */

const div = (a: number, b: number) => (b === 0 ? 0 : a / b);

export interface ClienteZona {
  nit: string;
  nombre: string;
  venta: number;
  /** Participación en la venta de la zona. */
  pct: number;
  /** Participación acumulada, clientes ordenados por venta desc. */
  pctAcum: number;
  /** Compra por mes, alineada con `ClientesPorZona.meses`. */
  porMes: number[];
}

export interface ZonaPareto {
  zona: string;
  venta: number;
  /** Clientes que hacen el 80 % de la venta de la zona. */
  clientes80: number;
  clientes: ClienteZona[];
}

export interface ClientesPorZona {
  meses: string[];
  /** "Todas las zonas" (consolidado) primero; luego Zona 1..N y "Sin zona". */
  zonas: ZonaPareto[];
  /** Venta del NIT genérico de mostrador, fuera del pareto: Σ zonas + esto = venta neta. */
  mostradorExcluido: number;
  mesesSinDato: string[];
}

/**
 * Pareto de clientes por zona (zona del vendedor, lib/hgi/zonas.ts) a partir de
 * los por_zona mensuales, que traen TODOS los clientes: el 80 % no se puede
 * calcular sobre un top-N. Sólo se excluye el NIT genérico de mostrador; un NIT
 * vacío se conserva para que las sumas cuadren.
 *
 * Además de cada zona arma el consolidado "Todas las zonas", con los clientes
 * unidos por NIT: uno atendido por dos vendedores cuenta una vez, con su compra
 * total, y el pareto del consolidado no es la unión de los paretos por zona.
 *
 * Un mes cuyo por_zona sigue por ciudad (construido antes de la regla por
 * vendedor) cuenta como sin dato: mezclarlo pintaría "MEDELLIN" junto a "Zona 1".
 */
export function clientesPorZona(partes: Array<{ mes: string; zonas: VentaPorZona[] | null }>): ClientesPorZona {
  partes = partes.map((p) => (p.zonas && !esPorZonaVendedor(p.zonas) ? { ...p, zonas: null } : p));
  const n = partes.length;
  type Clientes = Map<string, { nombre: string; porMes: number[] }>;
  const zonas = new Map<string, Clientes>();
  const todas: Clientes = new Map();
  const sumar = (cs: Clientes, nit: string, nombre: string, i: number, venta: number) => {
    const e = cs.get(nit) ?? { nombre, porMes: new Array<number>(n).fill(0) };
    e.porMes[i] += venta;
    cs.set(nit, e);
  };
  let mostradorExcluido = 0;
  partes.forEach((p, i) => {
    for (const z of p.zonas ?? []) {
      const cs: Clientes = zonas.get(z.zona) ?? new Map();
      for (const c of z.clientes) {
        if (c.nit === NIT_MOSTRADOR_GENERICO) {
          mostradorExcluido += c.venta;
          continue;
        }
        sumar(cs, c.nit, c.nombre, i, c.venta);
        sumar(todas, c.nit, c.nombre, i, c.venta);
      }
      if (cs.size) zonas.set(z.zona, cs);
    }
  });

  const out = [...(todas.size ? [[ZONA_TODAS, todas] as const] : []), ...zonas].map(([zona, cs]): ZonaPareto => {
    const lista = [...cs]
      .map(([nit, c]) => ({ nit, nombre: c.nombre, venta: c.porMes.reduce((s, v) => s + v, 0), porMes: c.porMes }))
      .sort((a, b) => b.venta - a.venta);
    const venta = lista.reduce((s, c) => s + c.venta, 0);
    let acum = 0;
    const clientes = lista.map((c) => {
      acum += c.venta;
      return { ...c, pct: div(c.venta, venta), pctAcum: div(acum, venta) };
    });
    const hasta80 = clientes.findIndex((c) => c.pctAcum >= 0.8);
    return { zona, venta, clientes80: hasta80 === -1 ? clientes.length : hasta80 + 1, clientes };
  });
  // El consolidado primero; las zonas en su orden (Zona 1..N, "Sin zona").
  out.sort((a, b) => (a.zona === ZONA_TODAS ? -1 : b.zona === ZONA_TODAS ? 1 : ordenZona(a.zona) - ordenZona(b.zona)));

  return {
    meses: partes.map((p) => p.mes),
    zonas: out,
    mostradorExcluido,
    mesesSinDato: partes.filter((p) => !p.zonas).map((p) => p.mes),
  };
}

/**
 * La respuesta principal lleva sólo el resumen de zonas: el detalle con todos los
 * clientes y su columna por mes pesa ~30 veces el resto (391 KB contra 13 KB en
 * la vista año) y en la vista mes viajaría de nuevo con cada página de la tabla
 * de documentos. El detalle de UNA zona se pide aparte con `parte=zona`.
 */
export function resumenZonas(z: ClientesPorZona) {
  return {
    meses: z.meses,
    zonas: z.zonas.map(({ zona, venta, clientes80, clientes }) => ({ zona, venta, clientes80, clientes: clientes.length })),
    mostradorExcluido: z.mostradorExcluido,
    mesesSinDato: z.mesesSinDato,
  };
}

/** Detalle de una zona; sin `zona` (o si no existe), la primera: el consolidado. */
export function detalleZona(z: ClientesPorZona | undefined, zona: string) {
  if (!z) return { meses: [], zona: null };
  return { meses: z.meses, zona: z.zonas.find((x) => x.zona === zona) ?? z.zonas[0] ?? null };
}
