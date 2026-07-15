'use client';

import { useState } from 'react';
import { categoryNames } from '@/types';
import { useProductos, formatPrice } from '@/lib/hooks/useProductos';
import { PageHeader, KpiCard, Card, Badge, Th, EmptyState } from '@/components/ui';

export default function CatalogoView() {
  const { products, loading, error } = useProductos();
  const [searchText, setSearchText] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  let filtered = products;
  if (searchText.trim()) {
    const q = searchText.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || p.barcode.includes(searchText));
  }
  if (categoryFilter !== 'all') filtered = filtered.filter(p => p.category === categoryFilter);

  const categories = Array.from(new Set(products.map(p => p.category)));
  const avgPrice = products.length
    ? products.reduce((sum, p) => sum + p.price, 0) / products.length
    : 0;

  const subtitle = loading
    ? 'Cargando catálogo desde HGINet…'
    : error
    ? `No se pudo cargar el catálogo: ${error}`
    : 'Catálogo en vivo desde HGINet';

  return (
    <div className="space-y-8">
      <PageHeader title="Catálogo" subtitle={subtitle} />

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <KpiCard label="Referencias" value={products.length} />
        <KpiCard label="Categorías" value={categories.length} />
        <KpiCard label="Precio promedio" value={formatPrice(avgPrice)} tone="accent" />
      </div>

      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-xl font-semibold tracking-tight text-ink">Productos</h2>
            {filtered.length !== products.length && (
              <p className="mt-1 text-xs text-ink-muted">
                Mostrando {filtered.length} de {products.length} referencias
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              placeholder="Buscar por nombre o código…"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="w-full rounded border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint sm:w-64"
            />
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
              className="rounded border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="all">Todas las categorías</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{categoryNames[cat]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px]">
            <thead className="bg-surface-muted">
              <tr className="border-b border-line">
                <Th>Producto</Th>
                <Th>Código</Th>
                <Th>Categoría</Th>
                <Th align="right">Precio</Th>
                <Th align="center">Disponibilidad</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      title={loading ? 'Cargando…' : 'No se encontraron productos'}
                      hint={loading ? undefined : 'Intenta ajustar la búsqueda'}
                    />
                  </td>
                </tr>
              ) : (
                filtered.map(product => (
                  <tr key={product.id} className="transition-colors hover:bg-surface-hover">
                    <td className="px-4 py-3 text-sm font-medium text-ink">{product.name}</td>
                    <td className="tabular px-4 py-3 font-mono text-xs text-ink-faint">{product.barcode}</td>
                    <td className="px-4 py-3 text-sm text-ink-muted">{categoryNames[product.category]}</td>
                    <td className="tabular px-4 py-3 text-right text-sm text-ink">{formatPrice(product.price)}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge tone={product.stock === 0 ? 'danger' : 'accent'}>
                        {product.stock === 0 ? 'Sin stock' : 'Disponible'}
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
