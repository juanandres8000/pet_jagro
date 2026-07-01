'use client';

import { useState, useEffect } from 'react';
import { mockPurchaseSuggestions } from '@/lib/mockData';
import { Product, PurchaseSuggestion, categoryNames, Order } from '@/types';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

interface TrackingViewProps {
  orders: Order[];
}

export default function TrackingView({ orders }: TrackingViewProps) {
  // Productos: datos REALES de HGINet (catálogo + stock de Inventario) vía /api/productos.
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  // Aviso si el inventario degradó (catálogo OK pero stock en 0).
  const [stockAviso, setStockAviso] = useState<string | null>(null);
  const [suggestions] = useState<PurchaseSuggestion[]>(mockPurchaseSuggestions);
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/productos');
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setProductsError(data?.mensaje || `Error ${res.status} al cargar productos`);
          setProducts([]);
        } else {
          setProducts(Array.isArray(data.products) ? data.products : []);
          setStockAviso(data?.inventario?.aviso ?? null);
        }
      } catch (e) {
        if (!cancelled) setProductsError((e as Error).message);
      } finally {
        if (!cancelled) setProductsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filtros por columna
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
    }).format(price);
  };

  const getFilteredProducts = () => {
    let result = products;

    // Aplicar filtro rápido (botones)
    switch (filter) {
      case 'low':
        result = result.filter(p => p.stock > 0 && p.stock <= p.minStock);
        break;
      case 'out':
        result = result.filter(p => p.stock === 0);
        break;
    }

    // Aplicar búsqueda por texto
    if (searchText.trim()) {
      result = result.filter(p =>
        p.name.toLowerCase().includes(searchText.toLowerCase()) ||
        p.barcode.includes(searchText)
      );
    }

    // Aplicar filtro por categoría
    if (categoryFilter !== 'all') {
      result = result.filter(p => p.category === categoryFilter);
    }

    // Aplicar filtro por estado
    if (statusFilter !== 'all') {
      switch (statusFilter) {
        case 'ok':
          result = result.filter(p => p.stock > p.minStock);
          break;
        case 'bajo':
          result = result.filter(p => p.stock > 0 && p.stock <= p.minStock);
          break;
        case 'agotado':
          result = result.filter(p => p.stock === 0);
          break;
      }
    }

    return result;
  };

  const filteredProducts = getFilteredProducts();
  const lowStockCount = products.filter(p => p.stock > 0 && p.stock <= p.minStock).length;
  const outOfStockCount = products.filter(p => p.stock === 0).length;
  const totalValue = products.reduce((sum, p) => sum + (p.stock * p.price), 0);

  const completedOrders = orders.filter(o => o.status === 'completed');

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Estadísticas - Horizontal Compacto */}
      <div className="flex items-center gap-4 px-4 sm:px-6 py-4 rounded-xl overflow-x-auto shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
        <div className="flex-1 text-center border-r min-w-[100px]" style={{ borderColor: '#E2E8F0' }}>
          <div className="text-2xl sm:text-3xl font-bold" style={{ color: '#7CB9E8' }}>{products.length}</div>
          <div className="text-xs uppercase tracking-wide" style={{ color: '#64748B' }}>Total</div>
        </div>
        <div className="flex-1 text-center border-r min-w-[100px]" style={{ borderColor: '#E2E8F0' }}>
          <div className="text-2xl sm:text-3xl font-bold" style={{ color: '#F59E0B' }}>{lowStockCount}</div>
          <div className="text-xs uppercase tracking-wide" style={{ color: '#64748B' }}>Stock Bajo</div>
        </div>
        <div className="flex-1 text-center border-r min-w-[100px]" style={{ borderColor: '#E2E8F0' }}>
          <div className="text-2xl sm:text-3xl font-bold" style={{ color: '#EF4444' }}>{outOfStockCount}</div>
          <div className="text-xs uppercase tracking-wide" style={{ color: '#64748B' }}>Agotados</div>
        </div>
        <div className="flex-1 text-center min-w-[120px]">
          <div className="text-xl sm:text-2xl font-bold" style={{ color: '#22C55E' }}>{formatPrice(totalValue)}</div>
          <div className="text-xs uppercase tracking-wide" style={{ color: '#64748B' }}>Valor Total</div>
        </div>
      </div>

      {/* Sugerencias de Compra */}
      <div className="rounded-xl p-3 sm:p-6 shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
        <h2 className="text-xl sm:text-2xl font-bold mb-3 sm:mb-4 flex items-center" style={{ color: '#1E293B', letterSpacing: '-0.5px' }}>
          <span className="mr-2">💡</span>
          Sugerencias de Compra
        </h2>

        <div className="space-y-4">
          {suggestions.map((suggestion) => {
            return (
              <div
                key={suggestion.id}
                className="rounded-lg p-4 transition-all duration-200"
                style={{ backgroundColor: '#F8FAFC', border: '1px solid #E2E8F0' }}
                onMouseEnter={(e) => e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.08)'}
                onMouseLeave={(e) => e.currentTarget.style.boxShadow = 'none'}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2 mb-2">
                      <h3 className="text-lg font-bold" style={{ color: '#1E293B' }}>{suggestion.product.name}</h3>
                      <span className="px-2 py-1 rounded-full text-xs font-semibold" style={{ backgroundColor: '#E2E8F0', color: '#64748B' }}>
                        {suggestion.urgency === 'high' ? 'URGENTE' :
                         suggestion.urgency === 'medium' ? 'PRONTO' : 'NORMAL'}
                      </span>
                    </div>

                    <div className="mb-2 text-sm" style={{ color: '#64748B' }}>
                      <span className="font-semibold">Razón: </span>
                      {suggestion.reason}
                    </div>

                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div>
                        <span style={{ color: '#64748B' }}>Stock actual: </span>
                        <span className="font-bold" style={{ color: '#1E293B' }}>{suggestion.product.stock}</span>
                      </div>
                      <div>
                        <span style={{ color: '#64748B' }}>Cantidad sugerida: </span>
                        <span className="font-bold" style={{ color: '#22C55E' }}>{suggestion.suggestedQuantity}</span>
                      </div>
                      <div>
                        <span style={{ color: '#64748B' }}>Costo estimado: </span>
                        <span className="font-bold" style={{ color: '#1E293B' }}>{formatPrice(suggestion.estimatedCost)}</span>
                      </div>
                    </div>
                  </div>

                  <button className="ml-4 px-4 py-2 rounded-lg transition-all duration-200 font-semibold text-sm text-white" style={{ backgroundColor: '#7CB9E8' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#5B9BD5'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#7CB9E8'}>
                    Generar Orden
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 pt-6" style={{ borderTop: '1px solid #E2E8F0' }}>
          <div className="flex items-center justify-between">
            <span className="text-lg font-semibold" style={{ color: '#1E293B' }}>Inversión Total Sugerida:</span>
            <span className="text-2xl font-bold" style={{ color: '#22C55E' }}>
              {formatPrice(suggestions.reduce((sum, s) => sum + s.estimatedCost, 0))}
            </span>
          </div>
        </div>
      </div>

      {/* Pedidos Terminados */}
      {completedOrders.length > 0 && (
        <div className="rounded-xl p-6 shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
          <h2 className="text-2xl font-bold mb-4" style={{ color: '#22C55E', letterSpacing: '-0.5px' }}>
            ✓ Pedidos Completados (Listos para Facturar)
          </h2>
          <div className="space-y-3">
            {completedOrders.map((order) => (
              <div
                key={order.id}
                className="rounded-lg p-4"
                style={{ backgroundColor: 'rgba(34, 197, 94, 0.08)', border: '1px solid rgba(34, 197, 94, 0.2)' }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-3 mb-1">
                      <span className="font-bold text-lg" style={{ color: '#1E293B' }}>{order.orderNumber}</span>
                      <span style={{ color: '#64748B' }}>- {order.customer.name}</span>
                    </div>
                    <div className="flex items-center space-x-4 text-sm" style={{ color: '#64748B' }}>
                      <span>{order.items.length} items</span>
                      <span className="font-bold" style={{ color: '#22C55E' }}>
                        {formatPrice(order.totalValue)}
                      </span>
                      {order.completedAt && (
                        <span>
                          Completado: {format(order.completedAt, "d 'de' MMMM, HH:mm", { locale: es })}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="px-3 py-1 rounded-full text-xs font-semibold" style={{ backgroundColor: 'rgba(124, 185, 232, 0.15)', color: '#7CB9E8' }}>
                    PENDIENTE FACTURACIÓN
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inventario Completo */}
      <div className="rounded-xl p-3 sm:p-6 shadow-sm" style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0' }}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold" style={{ color: '#1E293B', letterSpacing: '-0.5px' }}>Inventario Completo</h2>
            {productsLoading && (
              <p className="text-xs mt-1" style={{ color: '#64748B' }}>Cargando catálogo de HGINet…</p>
            )}
            {productsError && (
              <p className="text-xs mt-1" style={{ color: '#EF4444' }}>No se pudo cargar el catálogo: {productsError}</p>
            )}
            {!productsLoading && !productsError && stockAviso && (
              <p className="text-xs mt-1" style={{ color: '#F59E0B' }}>⚠ {stockAviso}</p>
            )}
            {!productsLoading && !productsError && !stockAviso && (
              <p className="text-[10px] mt-1" style={{ color: '#94A3B8' }}>
                Catálogo y stock en vivo desde HGINet
              </p>
            )}
            {filteredProducts.length !== products.length && (
              <p className="text-xs mt-1" style={{ color: '#64748B' }}>
                Mostrando {filteredProducts.length} de {products.length} productos
              </p>
            )}
          </div>

          {/* Filtros */}
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={() => setFilter('all')}
              className="px-3 sm:px-4 py-2 rounded-lg font-semibold transition-all duration-200 text-sm sm:text-base"
              style={
                filter === 'all'
                  ? { backgroundColor: '#7CB9E8', color: '#ffffff' }
                  : { backgroundColor: '#F1F5F9', color: '#64748B', border: '1px solid #E2E8F0' }
              }
            >
              Todos
            </button>
            <button
              onClick={() => setFilter('low')}
              className="px-3 sm:px-4 py-2 rounded-lg font-semibold transition-all duration-200 text-sm sm:text-base"
              style={
                filter === 'low'
                  ? { backgroundColor: '#F59E0B', color: '#ffffff' }
                  : { backgroundColor: '#F1F5F9', color: '#64748B', border: '1px solid #E2E8F0' }
              }
            >
              Stock Bajo
            </button>
            <button
              onClick={() => setFilter('out')}
              className="px-3 sm:px-4 py-2 rounded-lg font-semibold transition-all duration-200 text-sm sm:text-base"
              style={
                filter === 'out'
                  ? { backgroundColor: '#EF4444', color: '#ffffff' }
                  : { backgroundColor: '#F1F5F9', color: '#64748B', border: '1px solid #E2E8F0' }
              }
            >
              Agotados
            </button>
            {(searchText || categoryFilter !== 'all' || statusFilter !== 'all') && (
              <button
                onClick={() => {
                  setSearchText('');
                  setCategoryFilter('all');
                  setStatusFilter('all');
                }}
                className="px-3 sm:px-4 py-2 rounded-lg font-semibold transition-all duration-200 text-sm sm:text-base"
                style={{ backgroundColor: '#F1F5F9', color: '#64748B', border: '1px solid #E2E8F0' }}
                title="Limpiar filtros de columnas"
              >
                🗑️ Limpiar
              </button>
            )}
          </div>
        </div>

        <div className="overflow-x-auto -mx-3 sm:mx-0">
          <table className="w-full min-w-[640px]">
            <thead style={{ backgroundColor: '#F8FAFC' }}>
              <tr style={{ borderBottom: '1px solid #E2E8F0' }}>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-xs sm:text-sm font-semibold" style={{ color: '#1E293B' }}>Producto</th>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-xs sm:text-sm font-semibold" style={{ color: '#1E293B' }}>Categoría</th>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm font-semibold" style={{ color: '#1E293B' }}>Stock</th>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm font-semibold" style={{ color: '#1E293B' }}>Mín.</th>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-right text-xs sm:text-sm font-semibold" style={{ color: '#1E293B' }}>Precio</th>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm font-semibold" style={{ color: '#1E293B' }}>Estado</th>
              </tr>
              {/* Fila de Filtros */}
              <tr style={{ borderBottom: '2px solid #E2E8F0' }}>
                <th className="px-2 sm:px-4 py-2">
                  <input
                    type="text"
                    placeholder="Filtrar..."
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    className="w-full px-2 py-1 rounded text-xs"
                    style={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      color: '#1E293B'
                    }}
                  />
                </th>
                <th className="px-2 sm:px-4 py-2">
                  <select
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="w-full px-2 py-1 rounded text-xs"
                    style={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      color: '#1E293B'
                    }}
                  >
                    <option value="all">Todas</option>
                    {Array.from(new Set(products.map(p => p.category))).map(cat => (
                      <option key={cat} value={cat}>{categoryNames[cat]}</option>
                    ))}
                  </select>
                </th>
                <th className="px-2 sm:px-4 py-2"></th>
                <th className="px-2 sm:px-4 py-2"></th>
                <th className="px-2 sm:px-4 py-2"></th>
                <th className="px-2 sm:px-4 py-2">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full px-2 py-1 rounded text-xs"
                    style={{
                      backgroundColor: '#FFFFFF',
                      border: '1px solid #E2E8F0',
                      color: '#1E293B'
                    }}
                  >
                    <option value="all">Todos</option>
                    <option value="ok">OK</option>
                    <option value="bajo">Bajo</option>
                    <option value="agotado">Agotado</option>
                  </select>
                </th>
              </tr>
            </thead>
            <tbody style={{ borderTop: '1px solid #E2E8F0' }}>
              {filteredProducts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center">
                    <div style={{ color: '#64748B' }}>
                      <div className="text-2xl mb-2">📭</div>
                      <div className="font-semibold">No se encontraron productos</div>
                      <div className="text-sm mt-1">Intenta ajustar los filtros</div>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredProducts.map((product) => (
                <tr key={product.id} className="transition-all duration-200" style={{ borderBottom: '1px solid #E2E8F0' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#F8FAFC'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                  <td className="px-2 sm:px-4 py-2 sm:py-3">
                    <div className="font-medium text-xs sm:text-sm break-words" style={{ color: '#1E293B' }}>{product.name}</div>
                    <div className="text-[10px] sm:text-xs font-mono break-all" style={{ color: '#64748B' }}>{product.barcode}</div>
                  </td>
                  <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm" style={{ color: '#64748B' }}>
                    {categoryNames[product.category]}
                  </td>
                  <td className="px-2 sm:px-4 py-2 sm:py-3 text-center">
                    <span className="font-bold text-sm sm:text-base" style={{
                      color: product.stock === 0 ? '#EF4444' :
                             product.stock <= product.minStock ? '#F59E0B' :
                             '#22C55E'
                    }}>
                      {product.stock}
                    </span>
                  </td>
                  <td className="px-2 sm:px-4 py-2 sm:py-3 text-center text-xs sm:text-sm" style={{ color: '#64748B' }}>
                    {product.minStock}
                  </td>
                  <td className="px-2 sm:px-4 py-2 sm:py-3 text-right font-medium text-xs sm:text-sm" style={{ color: '#1E293B' }}>
                    {formatPrice(product.price)}
                  </td>
                  <td className="px-2 sm:px-4 py-2 sm:py-3 text-center">
                    {product.stock === 0 ? (
                      <span className="px-2 sm:px-3 py-1 rounded-full text-[10px] sm:text-xs font-semibold whitespace-nowrap" style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', color: '#EF4444' }}>
                        AGOTADO
                      </span>
                    ) : product.stock <= product.minStock ? (
                      <span className="px-2 sm:px-3 py-1 rounded-full text-[10px] sm:text-xs font-semibold whitespace-nowrap" style={{ backgroundColor: 'rgba(245, 158, 11, 0.15)', color: '#F59E0B' }}>
                        BAJO
                      </span>
                    ) : (
                      <span className="px-2 sm:px-3 py-1 rounded-full text-[10px] sm:text-xs font-semibold whitespace-nowrap" style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', color: '#22C55E' }}>
                        OK
                      </span>
                    )}
                  </td>
                </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
