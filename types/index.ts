// Types for J Agro Picking System

export interface User {
  id: string;
  name: string;
  role: 'admin' | 'picker' | 'supervisor';
  avatar?: string;
  online: boolean;
}

export interface Product {
  id: string;
  name: string;
  category: 'food' | 'toys' | 'accessories' | 'healthcare' | 'grooming' | 'other';
  stock: number;
  minStock: number;
  price: number;
  supplier?: string;
  barcode: string; // Código de barras para escaneo
  batchNumber?: string; // Número de lote (viene de HGI)
  imageUrl?: string; // URL de la imagen del producto
  lastUpdated: Date;
}

// Traducción de categorías
export const categoryNames: Record<Product['category'], string> = {
  food: 'Alimento',
  toys: 'Juguetes',
  accessories: 'Accesorios',
  healthcare: 'Salud',
  grooming: 'Aseo',
  other: 'Otros'
};

// Zonas de entrega
export type DeliveryZone = 'norte' | 'sur' | 'centro' | 'oriente' | 'occidente' | 'extramuros';

export const zoneNames: Record<DeliveryZone, string> = {
  norte: 'Norte',
  sur: 'Sur',
  centro: 'Centro',
  oriente: 'Oriente',
  occidente: 'Occidente',
  extramuros: 'Extramuros'
};

export const zoneColors: Record<DeliveryZone, string> = {
  norte: '#3b82f6',      // Azul
  sur: '#10b981',        // Verde
  centro: '#f59e0b',     // Naranja
  oriente: '#8b5cf6',    // Púrpura
  occidente: '#ec4899',  // Rosa
  extramuros: '#6b7280'  // Gris
};

// Estados del pedido
export type OrderStatus = 'pending' | 'in_progress' | 'completed' | 'ready_for_billing' | 'billed' | 'cancelled';

export const orderStatusNames: Record<OrderStatus, string> = {
  pending: 'Pendiente',
  in_progress: 'En Curso',
  completed: 'Completado',
  ready_for_billing: 'Listo para Facturar',
  billed: 'Facturado',
  cancelled: 'Cancelado'
};

// Item dentro de un pedido
export interface OrderItem {
  id: string;
  product: Product;
  quantity: number;
  scanned: boolean; // Si ya fue escaneado
  scannedQuantity: number; // Cantidad escaneada
  scannedAt?: Date;
}

// Pedido completo
export interface Order {
  id: string;
  orderNumber: string;
  customer: {
    name: string;
    phone?: string;
    address?: string;
    zone?: DeliveryZone; // Zona de entrega
    alertaCartera?: boolean; // cliente con alerta de cartera/bloqueo en el ERP
    motivoAlerta?: string | null; // texto crudo que disparó la alerta
    saldoVencido?: number; // saldo vencido del cliente (de cartera), si hay
    diasMaxMora?: number; // días máximos de mora del cliente
  };
  items: OrderItem[];
  status: OrderStatus;
  createdAt: Date;
  assignedTo?: string; // ID del picker asignado
  assignedAt?: Date;
  completedAt?: Date;
  totalValue: number;
  priority: 'low' | 'medium' | 'high';
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  content: string;
  timestamp: Date;
  type: 'text' | 'system' | 'alert' | 'query';
  productQuery?: ProductQuery;
}

export interface ProductQuery {
  action: 'search' | 'check_stock' | 'low_stock_alert';
  productName?: string;
  category?: string;
  results?: Product[];
}

export interface StockAlert {
  id: string;
  product: Product;
  message: string;
  severity: 'low' | 'critical' | 'out';
  timestamp: Date;
  acknowledged: boolean;
}

// Sugerencia de compra
export interface PurchaseSuggestion {
  id: string;
  product: Product;
  suggestedQuantity: number;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
  estimatedCost: number;
}

// ========== MÓDULO DE LIQUIDACIONES ==========

// Mensajero
export interface Messenger {
  id: string;
  name: string;
  phone: string;
  assignedZone?: DeliveryZone;
  active: boolean;
}

// Estado de entrega
export type DeliveryStatus = 'dispatched' | 'in_route' | 'delivered' | 'returned' | 'pending_payment';

export const deliveryStatusNames: Record<DeliveryStatus, string> = {
  dispatched: 'Despachado',
  in_route: 'En Ruta',
  delivered: 'Entregado',
  returned: 'Devuelto',
  pending_payment: 'Pendiente Pago'
};

export const deliveryStatusColors: Record<DeliveryStatus, string> = {
  dispatched: '#f59e0b',    // Naranja
  in_route: '#3b82f6',      // Azul
  delivered: '#10b981',     // Verde
  returned: '#ef4444',      // Rojo
  pending_payment: '#f59e0b' // Naranja
};

// Método de pago
export type PaymentMethod = 'cash' | 'transfer' | 'card' | 'credit';

export const paymentMethodNames: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  transfer: 'Transferencia',
  card: 'Datafono',
  credit: 'Crédito'
};

// Nota de crédito
export interface CreditNote {
  id: string;
  reason: string;
  amount: number;
  authorizedBy: string;
  createdAt: Date;
  description?: string;
}

// Entrega (delivery)
export interface Delivery {
  id: string;
  order: Order;
  messenger: Messenger;
  status: DeliveryStatus;
  paymentMethod?: PaymentMethod;
  creditNote?: CreditNote;
  dispatchedAt: Date;
  deliveredAt?: Date;
  collectedAmount?: number;
  notes?: string;
}

// ========== CHAT AI ==========

export interface AIChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}
