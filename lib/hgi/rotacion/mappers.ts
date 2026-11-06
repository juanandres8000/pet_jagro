/**
 * Rotación de inventario (docs/ROTACION.md): clasificación de los movimientos de
 * HGINet y cálculo de inicial, entradas, salidas, final, días en inventario,
 * cobertura y sugerido de compra. Funciones PURAS (tests/rotacion.test.ts).
 *
 * VALIDADO (6-nov-2026) contra el informe "ROTACIÓN DE INVENTARIOS" de HGI que
 * envió Jotagro (bodega 01, 1-may a 30-sep-2026): entradas y salidas idénticas
 * en 2.256 de 2.256 productos.
 *
 * Dos trampas de HGINet que esta tabla resuelve:
 *  1. El SIGNO de CantidadDocumento no dice la dirección: la entrada por traslado
 *     (12) y algunas notas crédito vienen negativas; deterioro (29) y salida por
 *     bonificados (32) vienen positivas. La dirección la da el CÓDIGO.
 *  2. Un documento puede traer líneas de corrección con el signo contrario (p. ej.
 *     traslado 3625: −12, −3, +6, −9). HGI las NETA dentro de la transacción; por
 *     eso se suma el efecto con signo dentro de su grupo y no se reclasifica por
 *     el signo de cada línea.
 */

export type Grupo =
  | 'ent_compra'
  | 'ent_traslado'
  | 'ent_devolucion'
  | 'ent_otras'
  | 'sal_venta'
  | 'sal_traslado'
  | 'sal_otras';

export const GRUPOS_ENTRADA: Grupo[] = ['ent_compra', 'ent_traslado', 'ent_devolucion', 'ent_otras'];
export const GRUPOS_SALIDA: Grupo[] = ['sal_venta', 'sal_traslado', 'sal_otras'];
export const GRUPOS: Grupo[] = [...GRUPOS_ENTRADA, ...GRUPOS_SALIDA];

/**
 * Código de transacción → grupo y factor. efecto en existencias = factor × cantidad.
 * Entradas suman el efecto; salidas suman −efecto (así ambas quedan positivas).
 */
export const TRANSACCIONES: Record<string, { grupo: Grupo; factor: 1 | -1; nombre: string }> = {
  // Compras (cantidad positiva)
  '40': { grupo: 'ent_compra', factor: 1, nombre: 'Factura de compra' },
  '45': { grupo: 'ent_compra', factor: 1, nombre: 'Factura de compra precio cero' },
  '03': { grupo: 'ent_compra', factor: 1, nombre: 'Factura de compra (anterior)' },
  '36': { grupo: 'ent_compra', factor: 1, nombre: 'Documento soporte electrónico' },
  // Traslados de entrada (cantidad negativa, espejo de la salida)
  '12': { grupo: 'ent_traslado', factor: -1, nombre: 'Entrada por traslado' },
  '57': { grupo: 'ent_traslado', factor: -1, nombre: 'Entrada para remisiones' },
  // Devoluciones de clientes (notas crédito)
  '06': { grupo: 'ent_devolucion', factor: -1, nombre: 'Nota crédito factura S.M.' },
  '51': { grupo: 'ent_devolucion', factor: -1, nombre: 'Nota crédito factura S.O.' },
  '55': { grupo: 'ent_devolucion', factor: -1, nombre: 'Nota crédito sin ref. S.O.' },
  '37': { grupo: 'ent_devolucion', factor: -1, nombre: 'Nota crédito sin ref. S.M.' },
  '42': { grupo: 'ent_devolucion', factor: 1, nombre: 'Nota crédito POS S.M.' },
  '28': { grupo: 'ent_devolucion', factor: 1, nombre: 'Nota crédito POS S.M. (anterior)' },
  '53': { grupo: 'ent_devolucion', factor: 1, nombre: 'Nota crédito POS S.O.' },
  '60': { grupo: 'ent_devolucion', factor: 1, nombre: 'Nota crédito POS electrónico S.O.' },
  // Otras entradas
  '13': { grupo: 'ent_otras', factor: 1, nombre: 'Entrada por ajuste' },
  '33': { grupo: 'ent_otras', factor: 1, nombre: 'Entrada por bonificados' },
  '38': { grupo: 'ent_otras', factor: 1, nombre: 'Entrada por préstamo' },
  '16': { grupo: 'ent_otras', factor: 1, nombre: 'Saldos iniciales' },
  // Ventas (cantidad positiva)
  '04': { grupo: 'sal_venta', factor: -1, nombre: 'Factura electrónica S.M.' },
  '43': { grupo: 'sal_venta', factor: -1, nombre: 'Factura electrónica mostrador' },
  '41': { grupo: 'sal_venta', factor: -1, nombre: 'POS electrónico S.M.' },
  '62': { grupo: 'sal_venta', factor: -1, nombre: 'POS electrónico Pet Shop' },
  '50': { grupo: 'sal_venta', factor: -1, nombre: 'Factura electrónica S.O.' },
  '59': { grupo: 'sal_venta', factor: -1, nombre: 'POS electrónico S.O.' },
  '66': { grupo: 'sal_venta', factor: -1, nombre: 'Factura electrónica insumos' },
  '25': { grupo: 'sal_venta', factor: -1, nombre: 'Factura POS S.M. (anterior)' },
  '52': { grupo: 'sal_venta', factor: -1, nombre: 'Factura POS S.O. (anterior)' },
  '90': { grupo: 'sal_venta', factor: -1, nombre: 'Factura de venta pruebas DIAN' },
  // Traslados de salida (cantidad negativa)
  '11': { grupo: 'sal_traslado', factor: 1, nombre: 'Traslado entre bodegas' },
  '56': { grupo: 'sal_traslado', factor: 1, nombre: 'Traslado para remisiones' },
  // Otras salidas
  '14': { grupo: 'sal_otras', factor: 1, nombre: 'Salida por ajuste' },
  '39': { grupo: 'sal_otras', factor: 1, nombre: 'Salida por préstamo' },
  '05': { grupo: 'sal_otras', factor: 1, nombre: 'Nota débito proveedores (devolución)' },
  '29': { grupo: 'sal_otras', factor: -1, nombre: 'Salida por deterioro' },
  '32': { grupo: 'sal_otras', factor: -1, nombre: 'Salida por bonificados' },
};

/**
 * Transacciones que NO llegan con la consulta de ventas (tipo_documento=1, '*') y
 * hay que pedir una por una con tipo_documento=0 y código explícito.
 */
export const TRANSACCIONES_TIPO0 = ['40', '45', '03', '36', '12', '57', '13', '33', '38', '16', '11', '56', '14', '39', '05', '29', '32'];

/** Bodegas de Jotagro (CodigoBodega de HGINet). */
export const BODEGAS: Record<string, string> = {
  '01': 'Medellín',
  '02': 'Oriente',
  '03': 'Insumos',
  '0': 'Temporal remisiones',
};

/**
 * Códigos que no son mercancía: '0' (GENERAL) y los comodines 999999983–999999999
 * (fletes, servicios…; uno solo llegó a 73 mil "salidas" en may–sep). El informe
 * de rotación de HGI no los trae. Sí trae 999999980/981 ("PRODUCTO IVA 19/5"), y
 * por eso se dejan, para cuadrar con HGI.
 */
export const esComodin = (codigo: string) => codigo === '0' || /^9{7}(8[3-9]|9\d)$/.test(codigo);

export interface HgiLineaInv {
  Id?: number | string;
  Fecha?: string;
  CodigoTransaccion?: string | number;
  CodigoBodega?: string | number;
  CodigoProducto?: string | number;
  NombreProducto?: string;
  NitProveedor?: string | number;
  NombreProveedor?: string;
  CantidadDocumento?: number | string;
}

export type Movimiento = Record<Grupo, number>;
export const movVacio = (): Movimiento => ({
  ent_compra: 0, ent_traslado: 0, ent_devolucion: 0, ent_otras: 0, sal_venta: 0, sal_traslado: 0, sal_otras: 0,
});

/** Fila de rot_movimiento (sin ventana ni lote). */
export interface FilaMovimiento extends Movimiento {
  bodega: string;
  codigo_producto: string;
  lineas: number;
}

export interface InfoProducto {
  codigo: string;
  nombre: string;
  nitProveedor: string;
  nombreProveedor: string;
}

const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Agrega líneas crudas por (bodega, producto). Ignora comodines y transacciones
 * que no mueven inventario. `sinMapa` cuenta códigos desconocidos: si HGI estrena
 * una transacción de inventario, la ingesta falla en vez de cuadrar mal en silencio.
 */
export function agregarMovimientos(lineas: HgiLineaInv[]): {
  filas: FilaMovimiento[];
  productos: Map<string, InfoProducto>;
  sinMapa: Record<string, number>;
} {
  const porClave = new Map<string, FilaMovimiento>();
  const productos = new Map<string, InfoProducto>();
  const sinMapa: Record<string, number> = {};
  for (const l of lineas) {
    const codigo = str(l.CodigoProducto);
    if (!codigo || esComodin(codigo)) continue;
    const tr = str(l.CodigoTransaccion);
    const t = TRANSACCIONES[tr];
    if (!t) {
      sinMapa[tr] = (sinMapa[tr] ?? 0) + 1;
      continue;
    }
    const bodega = str(l.CodigoBodega) || '0';
    const k = `${bodega}|${codigo}`;
    let f = porClave.get(k);
    if (!f) {
      f = { bodega, codigo_producto: codigo, lineas: 0, ...movVacio() };
      porClave.set(k, f);
    }
    const efecto = t.factor * num(l.CantidadDocumento);
    f[t.grupo] += t.grupo.startsWith('ent') ? efecto : -efecto;
    f.lineas++;
    const nit = str(l.NitProveedor);
    if (!productos.has(codigo) || (nit && !productos.get(codigo)!.nitProveedor)) {
      productos.set(codigo, {
        codigo,
        nombre: str(l.NombreProducto).replace(/^\|/, '') || codigo,
        nitProveedor: nit,
        nombreProveedor: str(l.NombreProveedor),
      });
    }
  }
  return { filas: [...porClave.values()], productos, sinMapa };
}

/** Saldo de HGINet (Inventario/ObtenerInventario), una fila por producto/bodega/lote. */
export interface HgiSaldoInv {
  CodigoProducto?: string | number;
  CodigoBodega?: string | number;
  Cantidad?: number | string;
  Costo?: number | string;
}

export interface FilaSaldo {
  bodega: string;
  codigo_producto: string;
  cantidad: number;
  /** Costo unitario promedio ponderado de los lotes con cantidad > 0. */
  costo_unitario: number;
}

/** Suma lotes por (bodega, producto). Los lotes negativos se suman (así lo totaliza HGI). */
export function agregarSaldos(raw: HgiSaldoInv[]): FilaSaldo[] {
  const m = new Map<string, { f: FilaSaldo; cantPos: number; valor: number }>();
  for (const s of raw) {
    const codigo = str(s.CodigoProducto);
    if (!codigo || esComodin(codigo)) continue;
    const bodega = str(s.CodigoBodega) || '0';
    const k = `${bodega}|${codigo}`;
    let x = m.get(k);
    if (!x) {
      x = { f: { bodega, codigo_producto: codigo, cantidad: 0, costo_unitario: 0 }, cantPos: 0, valor: 0 };
      m.set(k, x);
    }
    const q = num(s.Cantidad);
    x.f.cantidad += q;
    if (q > 0 && num(s.Costo) > 0) {
      x.cantPos += q;
      x.valor += q * num(s.Costo);
    }
  }
  return [...m.values()].map(({ f, cantPos, valor }) => ({ ...f, costo_unitario: cantPos ? Math.round(valor / cantPos) : 0 }));
}

// ------------------------------------------------------------- cálculo ---

export const entradas = (m: Movimiento) => m.ent_compra + m.ent_traslado + m.ent_devolucion + m.ent_otras;
export const salidas = (m: Movimiento) => m.sal_venta + m.sal_traslado + m.sal_otras;

/**
 * Con "todas las bodegas" los traslados entre bodegas no son movimiento: salen de
 * una y entran a otra. Se anulan para no inflar entradas ni salidas.
 */
export function sinTraslados(m: Movimiento): Movimiento {
  return { ...m, ent_traslado: 0, sal_traslado: 0 };
}

export function sumarMov(a: Movimiento, b: Movimiento): Movimiento {
  const out = movVacio();
  for (const g of GRUPOS) out[g] = a[g] + b[g];
  return out;
}

/** Umbrales de los estados (días de cobertura). */
export const UMBRAL_POR_AGOTARSE = 15;
export const UMBRAL_SOBRESTOCK = 120;

export type EstadoRot = 'agotado' | 'por_agotarse' | 'normal' | 'sobrestock' | 'sin_movimiento' | 'sin_existencia';

export interface ProductoRot {
  codigo: string;
  nombre: string;
  nitProveedor: string;
  nombreProveedor: string;
  inicial: number;
  entradas: number;
  compras: number;
  salidas: number;
  ventasNetas: number;
  final: number;
  /** Inventario promedio ÷ salidas × días del periodo. null sin salidas. */
  diasInventario: number | null;
  /** Salidas ÷ inventario promedio (veces que rota en el periodo). */
  rotacion: number | null;
  /** Existencia actual de la EMPRESA (todas las bodegas): es la que decide la compra. */
  existencia: number;
  costoUnitario: number;
  /** Existencia actual × costo unitario. */
  valorExistencia: number;
  ventaDiaria: number;
  /** Existencia actual ÷ venta diaria. null sin ventas. */
  cobertura: number | null;
  /** Unidades a pedir para cubrir `diasObjetivo` días al ritmo de venta del periodo. */
  sugerido: number;
  estado: EstadoRot;
}

export interface EntradaCalculo {
  info: InfoProducto;
  /** Movimiento dentro del periodo. */
  periodo: Movimiento;
  /** Movimiento desde el día siguiente al fin del periodo hasta el saldo. */
  posterior: Movimiento;
  existencia: number;
  costoUnitario: number;
  /**
   * Datos de TODAS las bodegas (movimiento sin traslados y existencia) para la
   * parte de compras: existencia, cobertura, sugerido y estado. Las compras son de
   * la empresa: si un producto pasó de la bodega 01 a la 03 (pasó con los insumos
   * en oct-2026), en la 01 queda en cero pero no está agotado. Sin esto, se usa la
   * misma bodega.
   */
  empresa?: { periodo: Movimiento; existencia: number; costoUnitario: number };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * final = existencia − neto(posterior); inicial = final − neto(periodo).
 * `dias` = días del periodo (hasta hoy si el periodo incluye el mes en curso).
 */
export function calcularProducto(e: EntradaCalculo, dias: number, diasObjetivo: number): ProductoRot {
  const ent = entradas(e.periodo);
  const sal = salidas(e.periodo);
  const final = e.existencia - (entradas(e.posterior) - salidas(e.posterior));
  const inicial = final - (ent - sal);
  const promedio = (inicial + final) / 2;
  const diasInventario = sal > 0 && promedio > 0 ? r1((promedio / sal) * dias) : null;
  const rotacion = promedio > 0 && sal > 0 ? Math.round((sal / promedio) * 100) / 100 : null;
  const ventasNetas = e.periodo.sal_venta - e.periodo.ent_devolucion;
  const c = e.empresa ?? { periodo: e.periodo, existencia: e.existencia, costoUnitario: e.costoUnitario };
  const ventasEmpresa = c.periodo.sal_venta - c.periodo.ent_devolucion;
  const salidasEmpresa = salidas(c.periodo);
  const ventaDiaria = dias > 0 && ventasEmpresa > 0 ? ventasEmpresa / dias : 0;
  const existencia = c.existencia;
  const cobertura = ventaDiaria > 0 ? r1(Math.max(0, existencia) / ventaDiaria) : null;
  const sugerido = ventaDiaria > 0 ? Math.max(0, Math.ceil(ventaDiaria * diasObjetivo - Math.max(0, existencia))) : 0;

  let estado: EstadoRot;
  if (ventaDiaria > 0 && existencia <= 0) estado = 'agotado';
  else if (cobertura !== null && cobertura < UMBRAL_POR_AGOTARSE) estado = 'por_agotarse';
  else if (existencia > 0 && salidasEmpresa <= 0) estado = 'sin_movimiento';
  else if (cobertura !== null && cobertura > UMBRAL_SOBRESTOCK) estado = 'sobrestock';
  else if (existencia <= 0 && salidasEmpresa <= 0) estado = 'sin_existencia';
  else estado = 'normal';

  return {
    codigo: e.info.codigo,
    nombre: e.info.nombre,
    nitProveedor: e.info.nitProveedor,
    nombreProveedor: e.info.nombreProveedor,
    inicial: r1(inicial),
    entradas: r1(ent),
    compras: r1(e.periodo.ent_compra),
    salidas: r1(sal),
    ventasNetas: r1(ventasNetas),
    final: r1(final),
    diasInventario,
    rotacion,
    existencia: r1(existencia),
    costoUnitario: c.costoUnitario,
    valorExistencia: Math.round(Math.max(0, existencia) * c.costoUnitario),
    ventaDiaria: Math.round(ventaDiaria * 100) / 100,
    cobertura,
    sugerido,
    estado,
  };
}

export interface ProveedorRot {
  nit: string;
  nombre: string;
  productos: number;
  inicial: number;
  entradas: number;
  salidas: number;
  final: number;
  valorExistencia: number;
  /** Ponderado por costo: Σ(promedio·costo) ÷ Σ(salidas·costo) × días. */
  diasInventario: number | null;
  agotados: number;
  porAgotarse: number;
  sinMovimiento: number;
  valorSinMovimiento: number;
  /** Σ sugerido × costo unitario. */
  valorSugerido: number;
}

export function porProveedor(productos: ProductoRot[], dias: number): ProveedorRot[] {
  const m = new Map<string, ProveedorRot & { _prom: number; _sal: number }>();
  for (const p of productos) {
    const nit = p.nitProveedor || '';
    let x = m.get(nit);
    if (!x) {
      x = {
        nit, nombre: p.nombreProveedor || 'Sin proveedor', productos: 0, inicial: 0, entradas: 0, salidas: 0, final: 0,
        valorExistencia: 0, diasInventario: null, agotados: 0, porAgotarse: 0, sinMovimiento: 0, valorSinMovimiento: 0,
        valorSugerido: 0, _prom: 0, _sal: 0,
      };
      m.set(nit, x);
    }
    const c = p.costoUnitario || 0;
    x.productos++;
    x.inicial += p.inicial;
    x.entradas += p.entradas;
    x.salidas += p.salidas;
    x.final += p.final;
    x.valorExistencia += p.valorExistencia;
    x._prom += Math.max(0, (p.inicial + p.final) / 2) * c;
    x._sal += Math.max(0, p.salidas) * c;
    if (p.estado === 'agotado') x.agotados++;
    if (p.estado === 'por_agotarse') x.porAgotarse++;
    if (p.estado === 'sin_movimiento') {
      x.sinMovimiento++;
      x.valorSinMovimiento += p.valorExistencia;
    }
    x.valorSugerido += p.sugerido * c;
  }
  return [...m.values()]
    .map(({ _prom, _sal, ...x }) => ({
      ...x,
      inicial: r1(x.inicial),
      entradas: r1(x.entradas),
      salidas: r1(x.salidas),
      final: r1(x.final),
      diasInventario: _sal > 0 ? r1((_prom / _sal) * dias) : null,
      valorSugerido: Math.round(x.valorSugerido),
    }))
    .sort((a, b) => b.valorExistencia - a.valorExistencia || a.nombre.localeCompare(b.nombre, 'es'));
}
