/**
 * Pagos confirmados del precio cero (migrations/013_dd_pago.sql). Cálculos PUROS,
 * cubiertos por tests/descuentos-pagos.test.ts. Ver docs/DESCUENTOS.md.
 *
 * La cobertura "observada" (resumen.ts) infiere lo devuelto a partir de HGINet y
 * puede mezclar descuentos comerciales normales. La "confirmada" sale de lo que
 * Viviana o contabilidad registran factura por factura: es la que decide si una
 * factura con precio cero ya se cobró.
 */

export const FORMAS_PAGO = ['nota_credito', 'producto', 'otro'] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];
export const FORMA_TEXTO: Record<FormaPago, string> = {
  nota_credito: 'Nota crédito',
  producto: 'Producto precio cero',
  otro: 'Otro',
};

/**
 * Pagado ≥ 99 % del costo ⇒ factura pagada (tolera redondeos del laboratorio).
 * Si el laboratorio valoró distinto, quien registra marca "saldada" a mano.
 */
export const UMBRAL_PAGADA = 0.99;

/** Factura de venta con al menos una línea en precio cero de un laboratorio. */
export interface FacturaP0 {
  nit: string;
  codigoTransaccion: string;
  documento: number;
  fecha: string; // YYYY-MM-DD
  cliente: string;
  /** Σ CostoTotal de las líneas en precio cero de ESE laboratorio. */
  costo: number;
  /** Σ precio de lista × cantidad de esas líneas. */
  lista: number;
  unidades: number;
}

export interface PagoDd {
  id: number;
  nit: string;
  codigoTransaccion: string;
  documento: number;
  fechaPago: string;
  forma: FormaPago;
  valor: number;
  salda: boolean;
  referencia: string | null;
  observacion: string | null;
  registradoPor: string;
  registradoEn: string; // ISO
}

/** Lo pagado de una factura (pagos vigentes, no anulados). */
export interface PagadoFactura {
  pagado: number;
  salda: boolean;
}

export type EstadoFactura = 'pagada' | 'parcial' | 'pendiente';

export interface EstadoPago {
  pagado: number;
  /** Lo que falta por cobrar de la factura; 0 si está pagada. */
  saldo: number;
  estado: EstadoFactura;
}

const r0 = (n: number) => Math.round(n);

export function estadoFactura(costo: number, p: PagadoFactura | undefined): EstadoPago {
  const pagado = p?.pagado ?? 0;
  if (p?.salda || (costo > 0 && pagado >= costo * UMBRAL_PAGADA) || (costo <= 0 && pagado > 0)) {
    return { pagado: r0(pagado), saldo: 0, estado: 'pagada' };
  }
  return { pagado: r0(pagado), saldo: r0(Math.max(0, costo - pagado)), estado: pagado > 0 ? 'parcial' : 'pendiente' };
}

export const claveFactura = (nit: string, codigoTransaccion: string, documento: number) =>
  `${nit}|${codigoTransaccion}|${documento}`;

export interface ConfirmadoLab {
  facturas: number;
  pagadas: number;
  parciales: number;
  pendientes: number;
  /** Σ pagos registrados de las facturas del periodo. */
  pagado: number;
  /** Σ saldo de las facturas no pagadas. */
  porCobrar: number;
  estado: 'sin_precio_cero' | 'pagado' | 'parcial' | 'pendiente';
}

/** Resume por laboratorio las facturas con precio cero y lo pagado de cada una. */
export function confirmadoPorLab(facturas: FacturaP0[], pagos: Map<string, PagadoFactura>): Map<string, ConfirmadoLab> {
  const out = new Map<string, ConfirmadoLab>();
  for (const f of facturas) {
    let c = out.get(f.nit);
    if (!c) {
      c = { facturas: 0, pagadas: 0, parciales: 0, pendientes: 0, pagado: 0, porCobrar: 0, estado: 'pendiente' };
      out.set(f.nit, c);
    }
    const e = estadoFactura(f.costo, pagos.get(claveFactura(f.nit, f.codigoTransaccion, f.documento)));
    c.facturas++;
    c.pagado += e.pagado;
    c.porCobrar += e.saldo;
    if (e.estado === 'pagada') c.pagadas++;
    else if (e.estado === 'parcial') c.parciales++;
    else c.pendientes++;
  }
  for (const c of out.values()) {
    c.estado = c.facturas === 0 ? 'sin_precio_cero' : c.pagadas === c.facturas ? 'pagado' : c.pagado > 0 ? 'parcial' : 'pendiente';
  }
  return out;
}

export const CONFIRMADO_VACIO: ConfirmadoLab = {
  facturas: 0, pagadas: 0, parciales: 0, pendientes: 0, pagado: 0, porCobrar: 0, estado: 'sin_precio_cero',
};

// ------------------------------------------------------------ validación ---

export interface PagoNuevo {
  nit: string;
  codigoTransaccion: string;
  documento: number;
  fechaPago: string;
  forma: FormaPago;
  valor: number;
  salda: boolean;
  referencia: string | null;
  observacion: string | null;
}

const FECHA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const texto = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, max);
  return t || null;
};

/**
 * Valida el cuerpo del POST. `hoy` (YYYY-MM-DD, Colombia) acota la fecha de pago:
 * no se registran pagos futuros.
 */
export function validarPago(body: unknown, hoy: string): { ok: true; pago: PagoNuevo } | { ok: false; mensaje: string } {
  if (!body || typeof body !== 'object') return { ok: false, mensaje: 'Cuerpo inválido' };
  const b = body as Record<string, unknown>;
  const nit = typeof b.nit === 'string' ? b.nit.trim() : '';
  const codigoTransaccion = typeof b.codigoTransaccion === 'string' ? b.codigoTransaccion.trim() : '';
  const documento = Number(b.documento);
  const fechaPago = typeof b.fechaPago === 'string' ? b.fechaPago : '';
  const forma = b.forma as FormaPago;
  const valor = typeof b.valor === 'number' ? b.valor : Number(b.valor);
  const salda = b.salda === true;

  if (!/^\d{5,15}$/.test(nit)) return { ok: false, mensaje: 'NIT del laboratorio inválido' };
  if (!/^[0-9A-Za-z]{1,10}$/.test(codigoTransaccion)) return { ok: false, mensaje: 'Transacción inválida' };
  if (!Number.isInteger(documento) || documento <= 0) return { ok: false, mensaje: 'Número de factura inválido' };
  // Además del formato, que EXISTA en el calendario (Date convierte 02-30 en 03-02).
  if (!FECHA.test(fechaPago) || new Date(`${fechaPago}T00:00:00Z`).toISOString().slice(0, 10) !== fechaPago) {
    return { ok: false, mensaje: 'Fecha de pago inválida' };
  }
  if (fechaPago > hoy) return { ok: false, mensaje: 'La fecha de pago no puede ser futura' };
  if (fechaPago < '2020-01-01') return { ok: false, mensaje: 'Fecha de pago demasiado antigua' };
  if (!FORMAS_PAGO.includes(forma)) return { ok: false, mensaje: 'Forma de pago inválida' };
  if (!Number.isFinite(valor) || valor < 0 || valor > 10_000_000_000) return { ok: false, mensaje: 'Valor inválido' };
  if (valor === 0 && !salda) return { ok: false, mensaje: 'Ingrese el valor o marque la factura como saldada' };

  return {
    ok: true,
    pago: {
      nit,
      codigoTransaccion,
      documento,
      fechaPago,
      forma,
      valor: Math.round(valor * 100) / 100,
      salda,
      referencia: texto(b.referencia, 60),
      observacion: texto(b.observacion, 300),
    },
  };
}
