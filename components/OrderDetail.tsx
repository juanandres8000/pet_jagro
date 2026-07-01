'use client';

import { useState } from 'react';
import { Order, OrderItem, categoryNames, zoneNames, zoneColors } from '@/types';
import BarcodeScanner from './BarcodeScanner';
import { mockProducts } from '@/lib/mockData';

interface OrderDetailProps {
  order: Order;
  onBack: () => void;
  onUpdate: (order: Order) => void;
}

export default function OrderDetail({ order: initialOrder, onBack, onUpdate }: OrderDetailProps) {
  const [order, setOrder] = useState<Order>(initialOrder);
  const [showScanner, setShowScanner] = useState(false);
  const [currentItem, setCurrentItem] = useState<OrderItem | null>(null);

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

  const handleSendToBilling = () => {
    const billingOrder = {
      ...order,
      status: 'ready_for_billing' as const,
    };
    setOrder(billingOrder);
    onUpdate(billingOrder);
    setTimeout(() => onBack(), 1000);
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
    <div className="space-y-4">
      {/* Header Minimalista */}
      <div className="flex items-center justify-between">
        <button
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2 rounded-lg transition-all duration-200"
          style={{ backgroundColor: '#FFFFFF', color: '#7CB9E8', border: '1px solid #E2E8F0' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#F8FAFC';
            e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.08)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#FFFFFF';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <span className="text-xl">←</span>
          <span className="font-semibold">Volver</span>
        </button>

        {order.status === 'completed' && (
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg" style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' }}>
            <span>✅</span>
            <span className="font-semibold">Completado</span>
          </div>
        )}
      </div>

      {/* Grid Layout - Info Cliente + Detalles */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Columna Izquierda - Info Cliente */}
        <div className="lg:col-span-1 space-y-4">
          {/* Card Cliente */}
          <div className="p-6 rounded-xl shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
            <div className="text-xs uppercase tracking-wide mb-3" style={{ color: '#64748B' }}>Pedido</div>
            <div className="text-3xl font-bold mb-4" style={{ color: '#7CB9E8', letterSpacing: '-1px' }}>
              {order.orderNumber}
            </div>

            <div className="text-xs uppercase tracking-wide mb-2" style={{ color: '#64748B' }}>Cliente</div>
            <div className="text-lg font-semibold mb-3" style={{ color: '#1E293B' }}>
              {order.customer.name}
            </div>

            <div className="space-y-2 text-sm" style={{ color: '#64748B' }}>
              <div className="flex items-start gap-2">
                <span>📞</span>
                <span>{order.customer.phone}</span>
              </div>
              <div className="flex items-start gap-2">
                <span>📍</span>
                <div className="flex-1">
                  <div className="mb-2">{order.customer.address}</div>
                  {order.customer.zone && (
                    <div
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold"
                      style={{
                        backgroundColor: `${zoneColors[order.customer.zone]}15`,
                        color: zoneColors[order.customer.zone],
                        border: `1px solid ${zoneColors[order.customer.zone]}30`
                      }}
                    >
                      <span>🗺️</span>
                      <span>Zona {zoneNames[order.customer.zone]}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-6 pt-6" style={{ borderTop: '1px solid #E2E8F0' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs uppercase" style={{ color: '#64748B' }}>Total</span>
                <span className="text-2xl font-bold" style={{ color: '#22C55E' }}>
                  {formatPrice(order.totalValue)}
                </span>
              </div>
            </div>
          </div>

          {/* Progreso */}
          {order.status !== 'pending' && (
            <div className="p-6 rounded-xl shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs uppercase tracking-wide" style={{ color: '#64748B' }}>Progreso</span>
                <span className="text-2xl font-bold" style={{ color: '#7CB9E8' }}>{Math.round(progress)}%</span>
              </div>
              <div className="h-2 rounded-full" style={{ backgroundColor: '#E2E8F0' }}>
                <div
                  className="h-2 rounded-full transition-all duration-500"
                  style={{ backgroundColor: '#7CB9E8', width: `${progress}%` }}
                />
              </div>
              <div className="mt-3 text-xs" style={{ color: '#64748B' }}>
                {order.items.filter(i => i.scanned).length} de {order.items.length} items escaneados
              </div>
            </div>
          )}

          {/* Botones de Acción */}
          {order.status === 'pending' && (
            <button
              onClick={handleAcceptOrder}
              className="w-full py-4 rounded-xl font-bold text-white transition-all duration-200"
              style={{ backgroundColor: '#7CB9E8' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#5B9BD5'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#7CB9E8'}
            >
              ✓ Aceptar y Comenzar
            </button>
          )}

          {order.status === 'completed' && (
            <button
              onClick={handleSendToBilling}
              className="w-full py-4 rounded-xl font-bold text-white transition-all duration-200"
              style={{ backgroundColor: '#7CB9E8' }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#5B9BD5'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#7CB9E8'}
            >
              💰 Pasar a Facturación
            </button>
          )}
        </div>

        {/* Columna Derecha - Tabla de Items */}
        <div className="lg:col-span-2">
          <div className="p-6 rounded-xl shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
            <h3 className="text-xl font-bold mb-4" style={{ color: '#1E293B', letterSpacing: '-0.5px' }}>
              Items del Pedido
            </h3>

            {/* Tabla Compacta */}
            <div className="space-y-2">
              {order.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-4 p-4 rounded-lg transition-all duration-200"
                  style={{
                    backgroundColor: item.scanned ? 'rgba(34, 197, 94, 0.08)' : '#F8FAFC',
                    border: item.scanned ? '1px solid rgba(34, 197, 94, 0.2)' : '1px solid #E2E8F0'
                  }}
                >
                  {/* Status Icon */}
                  <div className="flex-shrink-0">
                    {item.scanned ? (
                      <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: '#22C55E' }}>
                        <span className="text-white text-lg">✓</span>
                      </div>
                    ) : (
                      <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: '#F1F5F9', border: '2px dashed #94A3B8' }}>
                        <span style={{ color: '#94A3B8' }}>□</span>
                      </div>
                    )}
                  </div>

                  {/* Info Producto */}
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold mb-1" style={{ color: '#1E293B' }}>
                      {item.product.name}
                    </div>
                    <div className="flex items-center gap-3 text-xs" style={{ color: '#64748B' }}>
                      <span>{categoryNames[item.product.category]}</span>
                      <span>•</span>
                      <span className="font-mono">{item.product.barcode}</span>
                      {item.product.batchNumber && (
                        <>
                          <span>•</span>
                          <span>Lote: {item.product.batchNumber}</span>
                        </>
                      )}
                      <span>•</span>
                      <span>Stock: {item.product.stock}</span>
                      {item.quantity > item.product.stock && (
                        <span
                          className="px-2 py-0.5 rounded-full font-semibold"
                          style={{ backgroundColor: '#FEE2E2', color: '#991B1B' }}
                          title="Se pide más de lo disponible en stock"
                        >
                          ⚠ faltan {item.quantity - item.product.stock}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Cantidad */}
                  <div className="flex-shrink-0 text-center">
                    <div className="text-sm" style={{ color: '#64748B' }}>Cantidad</div>
                    <div className="text-xl font-bold" style={{ color: item.scanned ? '#22C55E' : '#7CB9E8' }}>
                      {item.scannedQuantity}/{item.quantity}
                    </div>
                  </div>

                  {/* Botón Escanear */}
                  {order.status === 'in_progress' && !item.scanned && (
                    <button
                      onClick={() => handleStartScanning(item)}
                      className="flex-shrink-0 px-6 py-3 rounded-lg font-semibold text-white transition-all duration-200"
                      style={{ backgroundColor: '#7CB9E8' }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#5B9BD5'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#7CB9E8'}
                    >
                      📷 Escanear
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
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
          allProducts={mockProducts}
        />
      )}
    </div>
  );
}
