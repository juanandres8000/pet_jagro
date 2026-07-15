'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';

interface QuantityModalProps {
  productName: string;
  barcode: string;
  onConfirm: (quantity: number) => void;
  onCancel: () => void;
}

export default function QuantityModal({
  productName,
  barcode,
  onConfirm,
  onCancel,
}: QuantityModalProps) {
  const [quantity, setQuantity] = useState(1);
  const [error, setError] = useState('');

  // Botones de cantidad rápida
  const quickButtons = [1, 6, 12, 24];

  const handleQuantityChange = (value: string) => {
    const num = parseInt(value);
    if (isNaN(num) || num < 1) {
      setError('La cantidad debe ser mayor a 0');
      return;
    }
    if (num > 1000) {
      setError('¿Estás seguro? Parece una cantidad muy alta');
    } else {
      setError('');
    }
    setQuantity(num);
  };

  const handleConfirm = () => {
    if (quantity < 1) {
      setError('La cantidad debe ser mayor a 0');
      return;
    }
    onConfirm(quantity);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirm();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 shadow-soft">
        {/* Header */}
        <div className="mb-6">
          <h2 className="font-serif text-xl font-semibold tracking-tight text-ink">
            ¿Cuántas unidades?
          </h2>
          <div className="mt-3 rounded border border-line bg-surface-muted p-3">
            <div className="text-xs font-medium uppercase tracking-wider text-ink-muted">
              Producto
            </div>
            <div className="mt-1 break-words font-medium text-ink">{productName}</div>
            <div className="mt-2 text-xs text-ink-muted">
              Código:{' '}
              <span className="tabular font-mono font-medium text-ink">{barcode}</span>
            </div>
          </div>
        </div>

        {/* Input de cantidad */}
        <div className="mb-4">
          <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-ink-muted">
            Cantidad a agregar
          </label>
          <input
            type="number"
            min="1"
            value={quantity}
            onChange={(e) => handleQuantityChange(e.target.value)}
            onKeyPress={handleKeyPress}
            autoFocus
            className="tabular w-full rounded border border-line bg-surface px-4 py-3 text-center font-serif text-2xl font-semibold text-ink transition-colors focus:border-accent focus:outline-none"
          />
        </div>

        {/* Botones rápidos */}
        <div className="mb-6">
          <div className="mb-2 text-xs text-ink-muted">Cantidades comunes</div>
          <div className="grid grid-cols-4 gap-2">
            {quickButtons.map((num) => (
              <button
                key={num}
                onClick={() => setQuantity(num)}
                className={`tabular rounded border px-3 py-2 text-sm font-medium transition-colors ${
                  quantity === num
                    ? 'border-accent bg-accent text-ink-inverse'
                    : 'border-line bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink'
                }`}
              >
                {num}
              </button>
            ))}
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mb-4 rounded border border-warn/15 bg-warn-soft px-3 py-2 text-sm text-warn">
            {error}
          </div>
        )}

        {/* Botones de acción */}
        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel} className="flex-1">
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleConfirm} className="flex-1">
            Confirmar
          </Button>
        </div>

        {/* Hint */}
        <div className="mt-4 text-center text-xs text-ink-faint">
          Presiona Enter para confirmar
        </div>
      </div>
    </div>
  );
}
