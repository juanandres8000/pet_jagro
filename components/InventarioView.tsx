'use client';

import { useState } from 'react';
import { categoryNames } from '@/types';
import { useProductos, formatPrice } from '@/lib/hooks/useProductos';
import { PageHeader, KpiCard, Card, Badge, FilterButton, Th, EmptyState, Tone } from '@/components/ui';

type StockFilter = 'all' | 'low' | 'out';

export default function InventarioView() {
  const { products, loading, error, stockAviso } = useProductos();
  const [filter, setFilter] = useState<StockFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const lowStockCount = products.filter(p => p.stock > 0 && p.stock <= p.minStock).length;
  const outOfStockCount = products.filter(p => p.stock === 0).length;
  const totalValue = products.reduce((sum, p) => sum + p.stock * p.price, 0);

  let filtered = products;
  if (filter === 'low') filtered = filtered.filter(p => p.stock > 0 && p.stock <= p.minStock);
  if (filter === 'out') filtered = filtered.filter(p => p.stock === 0);
  if (searchText.trim()) {
    const q = searchText.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || p.barcode.includes(searchText));
  }
  if (categoryFilter !== 'all') filtered = filtered.filter(p => p.category === categoryFilter);

  // Misma lógica de umbrales de siempre; sólo cambia la paleta.
  const stockTone = (stock: number, minStock: number): Tone =>
    stock === 0 ? 'danger' : stock <= minStock ? 'warn' : 'accent';
  const stockLabel = (stock: number, minStock: number) =>
    stock === 0 ? 'Agotado' : stock <= minStock ? 'Bajo' : 'OK';

  const subtitle = loading
    ? 'Cargando stock desde HGINet…'
    : error
    ? `No se pudo cargar el inventario: ${error}`
    : stockAviso
    ? `⚠ ${stockAviso}`
    : 'Stock en vivo desde HGINet';

  return (
    <div className="space-y-8">
      <PageHeader title="Inventario" subtitle={subtitle} />

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Referencias" value={products.length} />
        <KpiCard label="Stock bajo" value={lowStockCount} tone={lowStockCount > 0 ? 'warn' : 'neutral'} />
        <KpiCard label="Agotados" value={outOfStockCount} tone={outOfStockCount > 0 ? 'danger' : 'neutral'} />
        <KpiCard label="Valor total" value={formatPrice(totalValue)} tone="accent" />
      </div>

      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-xl font-semibold tracking-tight text-ink">Estado del stock</h2>
            {filtered.length !== products.length && (
              <p className="mt-1 text-xs text-ink-muted">
                Mostrando {filtered.length} de {products.length} referencias
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>Todos</FilterButton>
            <FilterButton active={filter === 'low'} onClick={() => setFilter('low')}>Stock bajo</FilterButton>
            <FilterButton active={filter === 'out'} onClick={() => setFilter('out')}>Agotados</FilterButton>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-b border-line px-6 py-4 sm:flex-row">
          <input
            type="text"
            placeholder="Buscar por nombre o código…"
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            className="w-full rounded border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint sm:max-w-xs"
          />
          <select
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
            className="rounded border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            <option value="all">Todas las categorías</option>
            {Array.from(new Set(products.map(p => p.category))).map(cat => (
              <option key={cat} value={cat}>{categoryNames[cat]}</option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead className="bg-surface-muted">
              <tr className="border-b border-line">
                <Th>Producto</Th>
                <Th>Categoría</Th>
                <Th align="right">Stock</Th>
                <Th align="right">Mínimo</Th>
                <Th align="right">Precio</Th>
                <Th align="center">Estado</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <EmptyState
                      title={loading ? 'Cargando…' : 'No se encontraron productos'}
                      hint={loading ? undefined : 'Intenta ajustar los filtros'}
                    />
                  </td>
                </tr>
              ) : (
                filtered.map(product => (
                  <tr key={product.id} className="transition-colors hover:bg-surface-hover">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-ink">{product.name}</div>
                      <div className="tabular mt-0.5 font-mono text-xs text-ink-faint">{product.barcode}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-muted">{categoryNames[product.category]}</td>
                    <td className={`tabular px-4 py-3 text-right text-sm font-semibold ${
                      product.stock === 0 ? 'text-danger' : product.stock <= product.minStock ? 'text-warn' : 'text-ink'
                    }`}>
                      {product.stock}
                    </td>
                    <td className="tabular px-4 py-3 text-right text-sm text-ink-muted">{product.minStock}</td>
                    <td className="tabular px-4 py-3 text-right text-sm text-ink">{formatPrice(product.price)}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge tone={stockTone(product.stock, product.minStock)}>
                        {stockLabel(product.stock, product.minStock)}
                      </Badge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
