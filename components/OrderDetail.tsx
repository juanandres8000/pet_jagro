'use client';

import { useState } from 'react';
import { Order, OrderItem, categoryNames } from '@/types';
import BarcodeScanner from './BarcodeScanner';
import { useProductos } from '@/lib/hooks/useProductos';
import { Card, SectionTitle, Badge, Button, ZoneBadge } from '@/components/ui';

interface OrderDetailProps {
  order: Order;
  onBack: () => void;
  onUpdate: (order: Order) => void;
}

export default function OrderDetail({ order: initialOrder, onBack, onUpdate }: OrderDetailProps) {
  const [order, setOrder] = useState<Order>(initialOrder);
  const [showScanner, setShowScanner] = useState(false);
  const [currentItem, setCurrentItem] = useState<OrderItem | null>(null);
  // Catálogo real de HGINet: el escáner lo usa para resolver códigos duplicados.
  const { products: allProducts } = useProductos();

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
    }).format(price);
  };

  const handleAcceptOrder = () => {
    const updatedOrder = {
      ...order,
      status: 'in_progress' as const,
      assignedTo: '2',
      assignedAt: new Date(),
    };
    setOrder(updatedOrder);
  };

  const handleStartScanning = (item: OrderItem) => {
    setCurrentItem(item);
    setShowScanner(true);
  };

  const handleScanSuccess = (barcode: string, quantity: number = 1) => {
    if (!currentItem) return;

    if (barcode === currentItem.product.barcode) {
      const updatedItems = order.items.map(item => {
        if (item.id === currentItem.id) {
          const newScannedQty = Math.min(item.scannedQuantity + quantity, item.quantity);
          return {
            ...item,
            scannedQuantity: newScannedQty,
            scanned: newScannedQty === item.quantity,
            scannedAt: new Date(),
          };
        }
        return item;
      });

      const updatedOrder = { ...order, items: updatedItems };
      setOrder(updatedOrder);
      setShowScanner(false);
      setCurrentItem(null);

      if (updatedItems.every(item => item.scanned)) {
        const completedOrder = {
          ...updatedOrder,
          status: 'completed' as const,
          completedAt: new Date(),
        };
        setOrder(completedOrder);
        onUpdate(completedOrder);
      }
    } else {
      alert('❌ Código incorrecto. Por favor escanea el producto correcto.');
    }
  };

  const allScanned = order.items.every(item => item.scanned);
  const progress = (order.items.reduce((sum, item) => sum + item.scannedQuantity, 0) /
                    order.items.reduce((sum, item) => sum + item.quantity, 0)) * 100;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <Button variant="secondary" onClick={onBack}>
          ← Volver
        </Button>

        {order.status === 'completed' && <Badge tone="accent">Completado</Badge>}
      </div>

      {/* Grid Layout - Info Cliente + Detalles */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Columna Izquierda - Info Cliente */}
        <div className="space-y-6 lg:col-span-1">
          {/* Card Cliente */}
          <Card className="p-6">
            <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">Pedido</div>
            <div className="tabular mt-2 font-serif text-3xl font-semibold tracking-tight text-ink">
              {order.orderNumber}
            </div>

            <div className="mt-6 text-xs font-medium uppercase tracking-wider text-ink-muted">
              Cliente
            </div>
            <div className="mt-1 text-lg font-medium text-ink">{order.customer.name}</div>

            <div className="mt-4 space-y-3 text-sm text-ink-muted">
              <div className="tabular">{order.customer.phone}</div>
              <div>
                <div>{order.customer.address}</div>
                {order.customer.zone && (
                  <div className="mt-2">
                    <ZoneBadge zone={order.customer.zone} prefix="Zona" />
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 border-t border-line pt-6">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                  Total
                </span>
                <span className="tabular font-serif text-2xl font-semibold text-accent">
                  {formatPrice(order.totalValue)}
                </span>
              </div>
            </div>
          </Card>

          {/* Progreso */}
          {order.status !== 'pending' && (
            <Card className="p-6">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                  Progreso
                </span>
                <span className="tabular font-serif text-2xl font-semibold text-ink">
                  {Math.round(progress)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="tabular mt-3 text-xs text-ink-muted">
                {order.items.filter(i => i.scanned).length} de {order.items.length} items escaneados
              </div>
            </Card>
          )}

          {/* Botones de Acción */}
          {order.status === 'pending' && (
            <Button variant="primary" onClick={handleAcceptOrder} className="w-full py-3">
              Aceptar y comenzar
            </Button>
          )}

          {/* `completed` es el estado terminal del picking: no hay transición a
              facturación porque ese módulo se retiró del producto. */}
          {order.status === 'completed' && (
            <div className="rounded border border-accent/15 bg-accent-soft p-4 text-center text-sm text-accent">
              Picking completado
            </div>
          )}
        </div>

        {/* Columna Derecha - Tabla de Items */}
        <div className="lg:col-span-2">
          <Card className="p-6">
            <SectionTitle as="h3">Items del pedido</SectionTitle>

            {/* Tabla Compacta */}
            <div className="mt-4 space-y-2">
              {order.items.map((item) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-4 rounded border p-4 transition-colors ${
                    item.scanned
                      ? 'border-accent/15 bg-accent-soft'
                      : 'border-line bg-surface-muted'
                  }`}
                >
                  {/* Status Icon */}
                  <div className="flex-shrink-0">
                    {item.scanned ? (
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-sm text-ink-inverse">
                        ✓
                      </div>
                    ) : (
                      <div className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-line-strong bg-surface text-ink-faint">
                        □
                      </div>
                    )}
                  </div>

                  {/* Info Producto */}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-ink">{item.product.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
                      <span>{categoryNames[item.product.category]}</span>
                      <span className="text-ink-faint">•</span>
                      <span className="tabular font-mono text-ink-faint">{item.product.barcode}</span>
                      {item.product.batchNumber && (
                        <>
                          <span className="text-ink-faint">•</span>
                          <span className="tabular">Lote: {item.product.batchNumber}</span>
                        </>
                      )}
                      <span className="text-ink-faint">•</span>
                      <span className="tabular">Stock: {item.product.stock}</span>
                      {item.quantity > item.product.stock && (
                        <span
                          className="tabular rounded border border-danger/15 bg-danger-soft px-2 py-0.5 font-medium text-danger"
                          title="Se pide más de lo disponible en stock"
                        >
                          Faltan {item.quantity - item.product.stock}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Cantidad */}
                  <div className="flex-shrink-0 text-center">
                    <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                      Cantidad
                    </div>
                    <div
                      className={`tabular mt-1 font-serif text-xl font-semibold ${
                        item.scanned ? 'text-accent' : 'text-ink'
                      }`}
                    >
                      {item.scannedQuantity}/{item.quantity}
                    </div>
                  </div>

                  {/* Botón Escanear */}
                  {order.status === 'in_progress' && !item.scanned && (
                    <Button
                      variant="primary"
                      onClick={() => handleStartScanning(item)}
                      className="flex-shrink-0"
                    >
                      Escanear
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Modal de escáner */}
      {showScanner && currentItem && (
        <BarcodeScanner
          onScanSuccess={handleScanSuccess}
          onClose={() => {
            setShowScanner(false);
            setCurrentItem(null);
          }}
          expectedBarcode={currentItem.product.barcode}
          productName={currentItem.product.name}
          allProducts={allProducts}
        />
      )}
    </div>
  );
}
