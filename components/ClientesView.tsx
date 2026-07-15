'use client';

import { useState, useEffect, useMemo } from 'react';
import type { Cliente } from '@/lib/hgi/mappers/terceros';
import type { CarteraCliente } from '@/lib/hgi/mappers/cartera';
import { PageHeader, Card, Badge, FilterButton, Th, EmptyState } from '@/components/ui';

const MAX_ROWS = 300;

// Toggle de subtipo de cliente. Los datos ya llegan filtrados a 1+7 desde el backend.
type ClienteFiltro = 'ambos' | '1' | '7';

interface TipoInfo {
  descripcion: string;
  count: number;
}

interface ClientesViewProps {
  /** Búsqueda inicial (p.ej. al navegar desde Cartera con un CodigoTercero). */
  initialSearch?: string;
}

export default function ClientesView({ initialSearch = '' }: ClientesViewProps) {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [tipos, setTipos] = useState<Record<string, TipoInfo>>({});
  const [carteraById, setCarteraById] = useState<Map<string, CarteraCliente>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const [search, setSearch] = useState(initialSearch);
  const [tipoFilter, setTipoFilter] = useState<ClienteFiltro>('ambos');

  // Sincroniza la búsqueda cuando llega un nuevo initialSearch (link de Cartera).
  useEffect(() => {
    if (initialSearch) setSearch(initialSearch);
  }, [initialSearch]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Clientes (fuente) + cartera (best-effort para el saldo) en paralelo.
        const [res, carRes] = await Promise.all([fetch('/api/clientes'), fetch('/api/cartera')]);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) {
          setError(data?.mensaje || `Error ${res.status}`);
        } else {
          setClientes(Array.isArray(data.clientes) ? data.clientes : []);
          setTipos(data.tiposCliente ?? {});
          setAviso(data.aviso ?? null);
          setStale(!!data.stale);
        }
        try {
          const car = await carRes.json();
          if (!cancelled && car?.ok && Array.isArray(car.clientes)) {
            setCarteraById(new Map((car.clientes as CarteraCliente[]).map((c) => [c.codigoTercero, c])));
          }
        } catch {
          /* cartera es opcional; sin ella no se muestra saldo */
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

  const formatCupo = (v: number) =>
    new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }).format(v);

  const filtered = useMemo(() => {
    let result = clientes;
    if (tipoFilter !== 'ambos') {
      result = result.filter((c) => c.codigoTipoTercero === tipoFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (c) =>
          c.nombre.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          (c.email?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [clientes, tipoFilter, search]);

  // Etiquetas del toggle con conteo (de tiposCliente, ya restringido a 1 y 7).
  const toggleOpts: Array<{ key: ClienteFiltro; label: string }> = [
    { key: 'ambos', label: `Ambos (${clientes.length})` },
    { key: '1', label: `Generales (${tipos['1']?.count ?? 0})` },
    { key: '7', label: `Mostrador (${tipos['7']?.count ?? 0})` },
  ];

  const subtitle = loading
    ? 'Cargando terceros desde HGINet…'
    : error
    ? `No se pudieron cargar: ${error}`
    : aviso
    ? aviso
    : `Terceros en vivo desde HGINet${stale ? ' · datos en caché (reintentando actualización)' : ''}`;

  return (
    <div className="space-y-8">
      <PageHeader title="Clientes" subtitle={subtitle} />

      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-xl font-semibold tracking-tight text-ink">Directorio de clientes</h2>
            <p className="mt-1 text-xs text-ink-muted">
              Mostrando {Math.min(filtered.length, MAX_ROWS)} de {filtered.length}
              {filtered.length > MAX_ROWS ? ' (primeros ' + MAX_ROWS + ', refina la búsqueda)' : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {toggleOpts.map((opt) => (
              <FilterButton
                key={opt.key}
                active={tipoFilter === opt.key}
                onClick={() => setTipoFilter(opt.key)}
              >
                {opt.label}
              </FilterButton>
            ))}
          </div>
        </div>

        <div className="border-b border-line px-6 py-4">
          <input
            type="text"
            placeholder="Buscar por nombre, identificación o email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint sm:max-w-md"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="bg-surface-muted">
              <tr className="border-b border-line">
                <Th>Nombre</Th>
                <Th>Identificación</Th>
                <Th>Tipo</Th>
                <Th>Ciudad</Th>
                <Th>Teléfono</Th>
                <Th>Email</Th>
                <Th align="right">Cupo</Th>
                <Th align="center">Plazo</Th>
                <Th align="center">Estado</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState
                      title={loading ? 'Cargando…' : 'Sin resultados'}
                      hint={loading ? undefined : 'Intenta ajustar la búsqueda o el filtro de tipo'}
                    />
                  </td>
                </tr>
              ) : (
                filtered.slice(0, MAX_ROWS).map((c) => (
                  <tr key={c.id} className="transition-colors hover:bg-surface-hover">
                    <td className="px-4 py-3">
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-ink">{c.nombre}</span>
                        {c.alertaCartera && (
                          <span title={c.motivoAlerta ?? 'Alerta de cartera'}>
                            <Badge tone="danger">Cartera</Badge>
                          </span>
                        )}
                        {(() => {
                          const car = carteraById.get(c.id);
                          return car && car.saldoVencido > 0 ? (
                            <span title={`Saldo vencido · días máx mora: ${car.diasMaxMora}`}>
                              <Badge tone="warn">
                                <span className="tabular">{formatCupo(car.saldoVencido)}</span>
                                <span className="ml-1">vencido</span>
                              </Badge>
                            </span>
                          ) : null;
                        })()}
                      </span>
                      {c.nombreComercial ? (
                        <span className="mt-0.5 block text-xs text-ink-faint">{c.nombreComercial}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="tabular font-mono text-xs text-ink-muted">{c.identificacion}</div>
                      <div className="mt-0.5 text-xs text-ink-faint">
                        {c.tipoIdentificacion} · {c.tipoPersona === 'juridica' ? 'Jurídica' : 'Natural'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-ink-muted">
                      {c.tipoTerceroDescripcion ?? c.codigoTipoTercero}
                    </td>
                    <td className="px-4 py-3 text-sm text-ink">{c.ciudad ?? '—'}</td>
                    <td className="tabular px-4 py-3 text-sm text-ink">{c.telefono ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{c.email ?? '—'}</td>
                    <td className="tabular px-4 py-3 text-right text-sm text-ink">
                      {c.cupo > 0 ? formatCupo(c.cupo) : '—'}
                    </td>
                    <td className="tabular px-4 py-3 text-center text-sm text-ink-muted">
                      {c.plazo > 0 ? `${c.plazo}d` : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge tone={c.activo ? 'accent' : 'danger'}>{c.activo ? 'Activo' : 'Inactivo'}</Badge>
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
