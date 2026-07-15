'use client';

import { Product, categoryNames } from '@/types';
import { useState } from 'react';
import { Button } from '@/components/ui';

interface ProductSelectionModalProps {
  barcode: string;
  products: Product[];
  onSelect: (product: Product) => void;
  onCancel: () => void;
}

export default function ProductSelectionModal({
  barcode,
  products,
  onSelect,
  onCancel,
}: ProductSelectionModalProps) {
  const [rememberChoice, setRememberChoice] = useState(false);

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: 'COP',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(price);
  };

  const handleSelect = (product: Product) => {
    if (rememberChoice) {
      // Guardar en sessionStorage para recordar durante esta sesión
      sessionStorage.setItem(`barcode_default_${barcode}`, product.id);
    }
    onSelect(product);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/20 p-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 shadow-soft">
        {/* Header con alerta */}
        <div className="mb-4 rounded border border-warn/15 bg-warn-soft p-3">
          <div className="text-sm font-medium text-warn">Código con múltiples productos</div>
          <p className="mt-1 text-xs text-ink-muted">
            El código <span className="tabular font-mono font-medium text-ink">{barcode}</span>{' '}
            corresponde a {products.length} presentaciones diferentes
          </p>
        </div>

        {/* Título */}
        <h2 className="mb-3 font-serif text-lg font-semibold tracking-tight text-ink">
          Selecciona la presentación correcta
        </h2>

        {/* Lista de productos para elegir */}
        <div className="mb-4 max-h-80 space-y-2 overflow-y-auto">
          {products.map((product) => (
            <button
              key={product.id}
              onClick={() => handleSelect(product)}
              className="w-full rounded border border-line bg-surface-muted p-4 text-left transition-colors hover:border-accent hover:bg-surface-hover"
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="font-medium text-ink">{product.name}</div>
                  <div className="mt-0.5 text-xs text-ink-muted">
                    {categoryNames[product.category]}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wider text-ink-muted">Stock</div>
                  <div
                    className={`tabular mt-0.5 text-sm font-semibold ${
                      product.stock > 0 ? 'text-ink' : 'text-danger'
                    }`}
                  >
                    {product.stock}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="tabular text-sm font-medium text-ink">
                  {formatPrice(product.price)}
                </span>
                <span className="text-xs font-medium text-accent">Seleccionar →</span>
              </div>
            </button>
          ))}
        </div>

        {/* Opción de recordar selección */}
        <div className="mb-4 rounded border border-line bg-surface-muted p-3">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={rememberChoice}
              onChange={(e) => setRememberChoice(e.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span className="flex-1 text-xs text-ink-muted">
              Recordar mi elección para este código durante esta sesión
            </span>
          </label>
        </div>

        {/* Botón cancelar */}
        <Button variant="secondary" onClick={onCancel} className="w-full">
          Cancelar
        </Button>
      </div>
    </div>
  );
}
