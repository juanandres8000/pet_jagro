import type { Order, OrderItem, Product, DeliveryZone } from '@/types';
import type { Pedido, PedidoLinea } from '@/lib/hgi/mappers/pedidos';
import type { Cliente } from '@/lib/hgi/mappers/terceros';

/**
 * Adaptador Pedido (nativo HGINet) → Order (tipo compartido del dashboard).
 * NO modifica el tipo Order. /api/pedidos sigue sirviendo el Pedido nativo; este
 * adaptador convierte a Order solo para la vista de picking.
 *
 * Decisiones (acordadas):
 * - status: siempre 'pending' (los pendientes de HGINet son estado inicial de picking).
 * - scanned=false, scannedQuantity=0: estado inicial correcto.
 * - priority: 'medium' uniforme — NO se inventa; se derivará de una señal real luego.
 * - stock disponible = stockTotal (la bodega "0" del pedido no almacena; el stock
 *   vive en 01/02). El faltante (pendiente > stockTotal) se detecta con
 *   item.quantity > item.product.stock (ver hayFaltante()).
 */

const ZONES: DeliveryZone[] = ['norte', 'sur', 'centro', 'oriente', 'occidente', 'extramuros'];

/** Mapea el nombre de zona de HGINet a DeliveryZone si coincide; si no, undefined. */
function toDeliveryZone(nombre: string): DeliveryZone | undefined {
  const z = nombre.trim().toLowerCase();
  return (ZONES as string[]).includes(z) ? (z as DeliveryZone) : undefined;
}

function parseFecha(fecha: string): Date {
  const d = new Date(fecha);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Línea de pedido enriquecida → OrderItem (con Product armado desde la línea). */
function lineaToItem(l: PedidoLinea): OrderItem {
  const product: Product = {
    id: l.codigoProducto,
    name: l.descripcion,
    category: 'other', // la línea del pedido no trae categoría; default
    stock: l.stockTotal ?? 0, // stockTotal = disponible accionable
    minStock: 0,
    price: l.valorUnitario,
    barcode: l.codigoProducto, // el reporte no trae EAN
    lastUpdated: new Date(),
  };
  return {
    id: `${l.codigoProducto}-${l.bodega}`,
    product,
    quantity: l.pendiente, // SaldoFinal = lo que falta por despachar
    scanned: false,
    scannedQuantity: 0,
  };
}

/**
 * Convierte un Pedido a Order. `clientesById` (opcional) enriquece
 * teléfono/dirección/ciudad cruzando NitTercero con el NumeroIdentificacion del
 * cliente. Si no matchea, esos campos quedan undefined (la vista los trata opcionales).
 */
export function pedidoToOrder(pedido: Pedido, clientesById?: Map<string, Cliente>): Order {
  const cli = clientesById?.get(pedido.cliente.nit);
  const address = cli ? [cli.direccion, cli.ciudad].filter(Boolean).join(', ') || undefined : undefined;

  return {
    id: pedido.numero,
    orderNumber: pedido.numero,
    customer: {
      name: pedido.cliente.nombre,
      phone: cli?.telefono,
      address,
      zone: toDeliveryZone(pedido.zona.nombre),
      alertaCartera: cli?.alertaCartera ?? false,
      motivoAlerta: cli?.motivoAlerta ?? null,
    },
    items: pedido.lineas.map(lineaToItem),
    status: 'pending',
    createdAt: parseFecha(pedido.fecha),
    totalValue: pedido.valorTotal,
    priority: 'medium',
  };
}

/** True si algún ítem pide más de lo disponible (pendiente > stockTotal). */
export function hayFaltante(order: Order): boolean {
  return order.items.some((it) => it.quantity > it.product.stock);
}

/** Ítems del pedido con faltante de inventario (para marcarlos en la UI). */
export function itemsConFaltante(order: Order): Set<string> {
  return new Set(order.items.filter((it) => it.quantity > it.product.stock).map((it) => it.id));
}
