'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ClaseSaldo } from '@/lib/hgi/mappers/clases';
import { Card, Th, EmptyState, SectionTitle, FilterButton } from '@/components/ui';
import { formatPrice } from '@/lib/format';

/**
 * Panel paginado de filas (tercero, banco, saldo) de /api/clases.
 *
 * Compartido por dos consumidores con la misma mecánica y distinta selección:
 *  - Cartera → los saldos A FAVOR del tercero (`signo=negativo`).
 *  - Composición → los terceros de una clase (`clase=X`).
 *
 * El filtrado, el orden y la paginación son SERVER-SIDE: este componente sólo
 * pide una página. Nunca baja el dataset completo para recortarlo aquí.
 */

const miles = (n: number) => n.toLocaleString('es-CO');

type Orden = 'saldo' | 'saldoAsc' | 'nombre';

interface Props {
  titulo: string;
  /** Filtros que se pasan tal cual a /api/clases. */
  clase?: string;
  signo?: 'negativo' | 'positivo';
  /** Orden inicial. En saldos a favor conviene saldoAsc (más negativo primero). */
  ordenInicial?: Orden;
  onCerrar?: () => void;
  /** Texto que acompaña al conteo, p.ej. el saldo de la selección. */
  pie?: string;
}

interface Estado {
  page: number;
  pageSize: number;
  total: number;
  filas: ClaseSaldo[];
  saldoSeleccion: number;
}

export default function TercerosSaldoPanel({
  titulo,
  clase,
  signo,
  ordenInicial = 'saldo',
  onCerrar,
  pie,
}: Props) {
  const [orden, setOrden] = useState<Orden>(ordenInicial);
  const [d, setD] = useState<Estado | null>(null);
  const [page, setPage] = useState(1);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cambiar de orden vuelve a la primera página.
  useEffect(() => setPage(1), [orden, clase, signo]);

  const cargar = useCallback(async () => {
    setCargando(true);
    const p = new URLSearchParams({ page: String(page), orden });
    if (clase !== undefined) p.set('clase', clase);
    if (signo !== undefined) p.set('signo', signo);
    // .catch(() => null) sobre el FETCH, no sólo sobre el .json(): un fetch que
    // rechaza no debe tumbar la vista que contiene este panel.
    const res = await fetch(`/api/clases?${p}`).catch(() => null);
    if (!res) {
      setError('No se pudo contactar al servidor');
      setCargando(false);
      return;
    }
    const j = (await res.json().catch(() => null)) as
      | { terceros?: Estado; saldoSeleccion?: number; aviso?: string }
      | null;
    if (!j?.terceros) {
      setError(j?.aviso ?? `Respuesta ilegible (HTTP ${res.status})`);
    } else {
      setError(null);
      setD({ ...j.terceros, saldoSeleccion: j.saldoSeleccion ?? 0 });
    }
    setCargando(false);
  }, [page, orden, clase, signo]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await cargar();
    })();
    return () => {
      cancelled = true;
    };
  }, [cargar]);

  const totalPaginas = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>{titulo}</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-ink-muted">Ordenar</span>
          <FilterButton active={orden === 'saldoAsc'} onClick={() => setOrden('saldoAsc')}>
            Más a favor
          </FilterButton>
          <FilterButton active={orden === 'saldo'} onClick={() => setOrden('saldo')}>
            Menos a favor
          </FilterButton>
          <FilterButton active={orden === 'nombre'} onClick={() => setOrden('nombre')}>
            Nombre
          </FilterButton>
          {onCerrar && (
            <button
              onClick={onCerrar}
              className="rounded border border-line px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              Cerrar
            </button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <p className="tabular text-xs text-ink-muted">
            {error ? (
              <span className="text-danger">No se pudo cargar: {error}</span>
            ) : (
              <>
                {miles(d?.total ?? 0)} registros · página {d?.page ?? 1} de {totalPaginas}
                {d ? ` · saldo de la selección ${formatPrice(d.saldoSeleccion)}` : ''}
                {pie ? ` · ${pie}` : ''}
                {cargando ? ' · actualizando…' : ''}
              </>
            )}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={(d?.page ?? 1) <= 1 || cargando}
              className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
            >
              ←
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPaginas, p + 1))}
              disabled={(d?.page ?? 1) >= totalPaginas || cargando}
              className="rounded border border-line px-2.5 py-1 text-sm text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:opacity-40"
            >
              →
            </button>
          </div>
        </div>

        {!d?.filas.length ? (
          <EmptyState title={cargando ? 'Cargando…' : 'Sin registros'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-muted">
                <tr>
                  <Th>Tercero</Th>
                  <Th>Banco</Th>
                  <Th align="right">Saldo</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.filas.map((f) => (
                  <tr key={`${f.tercero}-${f.codigoBanco}-${f.codigoClase}`} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5">
                      <div className="max-w-[22rem] truncate text-ink" title={f.nombreTercero}>
                        {f.nombreTercero}
                      </div>
                      <div className="tabular mt-0.5 font-mono text-[11px] text-ink-faint">{f.tercero}</div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-muted">{f.nombreBanco}</td>
                    <td
                      className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-medium ${
                        f.saldo < 0 ? 'text-danger' : 'text-ink'
                      }`}
                    >
                      {formatPrice(f.saldo)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
