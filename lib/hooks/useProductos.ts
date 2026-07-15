'use client';

import { useState, useEffect } from 'react';
import { Product } from '@/types';

interface ProductosState {
  products: Product[];
  loading: boolean;
  error: string | null;
  /** Aviso si el inventario degradó (catálogo OK pero stock en 0). */
  stockAviso: string | null;
}

/**
 * Catálogo + stock REALES de HGINet vía /api/productos (caché read-through en Neon).
 * Compartido por Inventario y Catálogo, que son dos lecturas de la misma fuente.
 */
export function useProductos(): ProductosState {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stockAviso, setStockAviso] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/productos');
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setError(data?.mensaje || `Error ${res.status} al cargar productos`);
          setProducts([]);
        } else {
          setProducts(Array.isArray(data.products) ? data.products : []);
          setStockAviso(data?.inventario?.aviso ?? null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { products, loading, error, stockAviso };
}
