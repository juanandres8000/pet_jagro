import type { Product } from '@/types';
import type { SaldoProducto } from './inventario';

/**
 * Mapper: objeto Producto de HGINet (Api/Productos/Obtener) → tipo Product del dashboard.
 *
 * Recurso SOLO de catálogo: NO trae existencias/stock. El stock real es el
 * servicio de Inventario/Kardex (otro endpoint, siguiente slice). Por eso
 * stock/minStock quedan en 0 aquí; eso hará que la vista muestre "sin stock"
 * hasta que se conecte el Kardex.
 *
 * Los nombres de campo siguen la spec del manual técnico, pero se leen de forma
 * tolerante (en auth el manual tuvo discrepancias): para cada campo se aceptan
 * variantes razonables y se aplica un default sensato si falta.
 */

// Objeto crudo de HGINet (campos opcionales: el endpoint manda la verdad).
export interface HgiProducto {
  Codigo?: string | number;
  Descripcion?: string;
  CodigoEAN?: string | number;
  CodigoAlterno?: string | number;
  CodigoLinea?: string | number;
  CodigoGrupo?: string | number;
  CodigoUnidad?: string | number;
  Precio1?: number | string;
  Precio2?: number | string;
  Precio3?: number | string;
  Precio4?: number | string;
  Precio5?: number | string;
  Precio6?: number | string;
  Precio7?: number | string;
  Precio8?: number | string;
  CodigoTarifaIVA?: string | number;
  ManejaLote?: number | string;
  ValidarKardex?: number | string;
  Vigente?: number | string;
  CodigoMoneda?: string | number;
  Descuento?: number | string;
  Orden?: number | string;
  FechaActualizacion?: string;
  MaximoMinimo?: Array<{ Bodega?: string | number; Maximo?: number | string; Minimo?: number | string }> | null;
  [key: string]: unknown; // tolerar campos extra del endpoint
}

/**
 * DTO de salida: Product + desglose de stock por bodega (para picking).
 * Extiende Product, así que es asignable a Product[] sin romper la UI; el campo
 * extra viaja en el JSON y las vistas que no lo usan simplemente lo ignoran.
 */
export interface ProductoDTO extends Product {
  stockPorBodega?: Record<string, number>;
}

const str = (v: unknown, def = ''): string =>
  v === undefined || v === null ? def : String(v).trim();

const num = (v: unknown, def = 0): number => {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : def;
};

/** 0/1, "0"/"1", true/false → boolean. */
const flag = (v: unknown): boolean => v === 1 || v === '1' || v === true;

/**
 * Mapea CodigoLinea de HGINet → category del dashboard.
 * Líneas reales (LineasProductos/Obtener):
 *   0 GENERAL · 01 MEDICAMENTOS/SUPLEMENTOS · 02 ALIMENTOS/SNACKS ·
 *   03 INSUMOS HOSPITALARIOS · 04 DIAGNOSTICOS · 05 JUGUETES/ACCESORIOS ·
 *   11 SERVICIOS · 12 GASTOS GENERALES
 */
const LINEA_TO_CATEGORY: Record<string, Product['category']> = {
  '02': 'food',
  '05': 'toys',
  '01': 'healthcare',
  '03': 'healthcare',
  '04': 'healthcare',
  '0': 'other',
  '11': 'other',
  '12': 'other',
};

function categoryFromLinea(codigoLinea: string): Product['category'] {
  return LINEA_TO_CATEGORY[codigoLinea] ?? 'other';
}

export interface MapOptions {
  /** Índice de la lista de precio a usar como precio principal (1-8). Default 1. */
  listaPrecio?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  /** Solo productos habilitados (Vigente=1). Default true. */
  soloVigentes?: boolean;
}

function precioDeLista(p: HgiProducto, lista: number): number {
  const key = `Precio${lista}` as keyof HgiProducto;
  return num(p[key], 0);
}

/** Limpia la descripción: HGINet antepone un "|" basura en muchos productos. */
function limpiarNombre(desc: string, fallback: string): string {
  const clean = desc.replace(/^\|+\s*/, '').trim();
  return clean || fallback;
}

/** Colombia es UTC-5 permanente; FechaActualizacion viene naive en hora local. */
function parseFecha(fecha?: string): Date {
  if (fecha) {
    const t = Date.parse(`${fecha.replace(/(\.\d{3})\d+$/, '$1')}-05:00`);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date();
}

/** minStock del producto = suma de Minimo de MaximoMinimo sobre todas las bodegas. */
function minStockFromMaximoMinimo(p: HgiProducto): number {
  if (!Array.isArray(p.MaximoMinimo)) return 0;
  return p.MaximoMinimo.reduce((sum, mm) => sum + num(mm?.Minimo, 0), 0);
}

/**
 * Mapea UN producto de HGINet → ProductoDTO.
 * El stock real se inyecta vía `saldo` (cruce con Inventario); si no hay saldo,
 * stock = 0 (producto sin existencias o inventario no disponible).
 */
export function mapProducto(p: HgiProducto, opts: MapOptions = {}, saldo?: SaldoProducto): ProductoDTO {
  const lista = opts.listaPrecio ?? 1;
  const codigo = str(p.Codigo);
  return {
    id: codigo,
    name: limpiarNombre(str(p.Descripcion), codigo || 'Sin nombre'),
    category: categoryFromLinea(str(p.CodigoLinea)),
    // Stock REAL desde Inventario/Kardex (0 si el producto no tiene saldo).
    stock: saldo?.total ?? 0,
    minStock: minStockFromMaximoMinimo(p),
    price: precioDeLista(p, lista),
    // CodigoEAN como código de barras; fallbacks razonables.
    barcode: str(p.CodigoEAN) || str(p.CodigoAlterno) || codigo,
    // imageUrl/batchNumber no vienen en catálogo (incluir_foto=false).
    imageUrl: undefined,
    batchNumber: undefined,
    // Fecha real de última actualización del catálogo en HGINet.
    lastUpdated: parseFecha(p.FechaActualizacion),
    // Desglose por bodega para picking (sólo si hay saldo).
    stockPorBodega: saldo?.porBodega,
  };
}

/**
 * Mapea el array de Productos de HGINet → ProductoDTO[], cruzando con el inventario.
 * Filtra Vigente=1 por defecto. Tolera array vacío/nulo y mapa de inventario ausente.
 *
 * @param inventario Map<CodigoProducto, SaldoProducto>. Si se omite (p.ej. Inventario
 *                   falló), todos los productos quedan con stock 0 sin romper el catálogo.
 */
export function mapProductos(
  raw: unknown,
  opts: MapOptions = {},
  inventario?: Map<string, SaldoProducto>,
): ProductoDTO[] {
  if (!Array.isArray(raw)) return [];
  const soloVigentes = opts.soloVigentes ?? true;
  return raw
    .filter((p): p is HgiProducto => !!p && typeof p === 'object')
    .filter((p) => (soloVigentes ? flag(p.Vigente) : true))
    .map((p) => mapProducto(p, opts, inventario?.get(str(p.Codigo))));
}
