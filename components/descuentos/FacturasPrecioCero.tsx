'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, FilterButton, Th, type Tone } from '@/components/ui';
import { formatPrice } from '@/lib/format';
import { FORMA_TEXTO, FORMAS_PAGO, type FormaPago, type PagoDd } from '@/lib/hgi/descuentos/pagos';

/**
 * Facturas con precio cero de un laboratorio y sus pagos confirmados
 * (docs/DESCUENTOS.md § "Pagos confirmados"). Quien está autorizado
 * (lib/hgi/descuentos/permisos.ts) registra y anula pagos factura por factura;
 * el resto sólo ve. Todo el cálculo viene de /api/descuentos/facturas.
 */

interface Factura {
  nit: string;
  codigoTransaccion: string;
  documento: number;
  fecha: string;
  cliente: string;
  costo: number;
  lista: number;
  unidades: number;
  pagado: number;
  saldo: number;
  estado: 'pagada' | 'parcial' | 'pendiente';
  pagos: PagoDd[];
}

interface Resp {
  ok: boolean;
  mensaje?: string;
  tablaPagos: boolean;
  puedeRegistrar: boolean;
  facturas: Factura[];
}

const ESTADO: Record<Factura['estado'], { texto: string; tone: Tone }> = {
  pagada: { texto: 'Pagada', tone: 'accent' },
  parcial: { texto: 'Parcial', tone: 'warn' },
  pendiente: { texto: 'Pendiente', tone: 'danger' },
};

const fechaCorta = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const hoyLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const claveDe = (f: { codigoTransaccion: string; documento: number }) => `${f.codigoTransaccion}-${f.documento}`;

const INPUT = 'w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink';

function FormPago({ f, onListo, onCancelar }: { f: Factura; onListo: () => void; onCancelar: () => void }) {
  const [fechaPago, setFechaPago] = useState(hoyLocal());
  const [forma, setForma] = useState<FormaPago>('nota_credito');
  const [valor, setValor] = useState(f.saldo > 0 ? String(f.saldo) : '');
  const [salda, setSalda] = useState(false);
  const [referencia, setReferencia] = useState('');
  const [observacion, setObservacion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    const res = await fetch('/api/descuentos/pagos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nit: f.nit,
        codigoTransaccion: f.codigoTransaccion,
        documento: f.documento,
        fechaPago,
        forma,
        // Acepta "1.234.567" o "1234567,50" como se escribe en Colombia.
        valor: Number(valor.replace(/\./g, '').replace(',', '.') || '0'),
        salda,
        referencia,
        observacion,
      }),
    }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    setEnviando(false);
    if (!j?.ok) {
      setError(j?.mensaje ?? 'No se pudo contactar al servidor');
      return;
    }
    onListo();
  };

  return (
    <div className="grid gap-3 rounded border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-xs text-ink-muted">
        Fecha del pago
        <input type="date" className={INPUT} value={fechaPago} max={hoyLocal()} onChange={(e) => setFechaPago(e.target.value)} />
      </label>
      <label className="text-xs text-ink-muted">
        Cómo pagó el laboratorio
        <select className={INPUT} value={forma} onChange={(e) => setForma(e.target.value as FormaPago)}>
          {FORMAS_PAGO.map((x) => (
            <option key={x} value={x}>{FORMA_TEXTO[x]}</option>
          ))}
        </select>
      </label>
      <label className="text-xs text-ink-muted">
        Valor (a costo: {formatPrice(f.costo)})
        <input inputMode="decimal" className={`${INPUT} tabular`} value={valor} onChange={(e) => setValor(e.target.value)} placeholder="0" />
      </label>
      <label className="text-xs text-ink-muted">
        Nº nota crédito / factura de compra
        <input className={INPUT} value={referencia} maxLength={60} onChange={(e) => setReferencia(e.target.value)} />
      </label>
      <label className="text-xs text-ink-muted sm:col-span-2">
        Observación
        <input className={INPUT} value={observacion} maxLength={300} onChange={(e) => setObservacion(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 text-xs text-ink sm:col-span-2 lg:col-span-3">
        <input type="checkbox" checked={salda} onChange={(e) => setSalda(e.target.checked)} />
        Dar la factura por pagada aunque el valor no llegue al costo (el laboratorio la repuso completa)
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
        <Button onClick={guardar} disabled={enviando}>{enviando ? 'Guardando…' : 'Guardar pago'}</Button>
        <Button variant="secondary" onClick={onCancelar} disabled={enviando}>Cancelar</Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </div>
  );
}

function PagosFactura({ f, puedeRegistrar, onCambio }: { f: Factura; puedeRegistrar: boolean; onCambio: () => void }) {
  const [confirmar, setConfirmar] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anular = async (id: number) => {
    setError(null);
    const res = await fetch(`/api/descuentos/pagos?id=${id}`, { method: 'DELETE' }).catch(() => null);
    const j = res ? await res.json().catch(() => null) : null;
    setConfirmar(null);
    if (!j?.ok) setError(j?.mensaje ?? 'No se pudo contactar al servidor');
    else onCambio();
  };
  if (!f.pagos.length) return <p className="text-xs text-ink-faint">Sin pagos registrados.</p>;
  return (
    <div className="space-y-1">
      {f.pagos.map((p) => (
        <div key={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span className="tabular text-ink">{fechaCorta(p.fechaPago)}</span>
          <span>{FORMA_TEXTO[p.forma]}</span>
          <span className="tabular text-ink">{formatPrice(p.valor)}</span>
          {p.salda && <Badge tone="accent">Saldada</Badge>}
          {p.referencia && <span>Ref. {p.referencia}</span>}
          {p.observacion && <span className="italic">{p.observacion}</span>}
          <span className="text-ink-faint">· {p.registradoPor}</span>
          {puedeRegistrar &&
            (confirmar === p.id ? (
              <span className="flex gap-2">
                <button type="button" className="font-medium text-danger underline" onClick={() => anular(p.id)}>Sí, anular</button>
                <button type="button" className="underline" onClick={() => setConfirmar(null)}>No</button>
              </span>
            ) : (
              <button type="button" className="text-danger underline" onClick={() => setConfirmar(p.id)}>Anular</button>
            ))}
        </div>
      ))}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

export default function FacturasPrecioCero({
  nit,
  desde,
  hasta,
  onCambio,
}: {
  nit: string;
  desde: string; // YYYY-MM
  hasta: string; // YYYY-MM
  /** Avisa a la vista padre que cambió lo pagado (para refrescar totales). */
  onCambio: () => void;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<'pendientes' | 'todas'>('pendientes');
  const [abierta, setAbierta] = useState<string | null>(null);
  const [formAbierto, setFormAbierto] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    const res = await fetch(`/api/descuentos/facturas?nit=${encodeURIComponent(nit)}&desde=${desde}&hasta=${hasta}`).catch(() => null);
    const j = (res ? await res.json().catch(() => null) : null) as Resp | null;
    if (!j) setError('No se pudo contactar al servidor');
    else if (!j.ok) setError(j.mensaje ?? 'Error desconocido');
    else {
      setError(null);
      setData(j);
    }
  }, [nit, desde, hasta]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const cambio = () => {
    setFormAbierto(null);
    void cargar();
    onCambio();
  };

  const facturas = useMemo(
    () => (data?.facturas ?? []).filter((f) => filtro === 'todas' || f.estado !== 'pagada'),
    [data, filtro],
  );

  if (error) return <p className="text-xs text-danger">No se pudieron cargar las facturas: {error}</p>;
  if (!data) return <p className="text-xs text-ink-faint">Cargando facturas con precio cero…</p>;

  const total = data.facturas.length;
  const pagadas = data.facturas.filter((f) => f.estado === 'pagada').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-medium text-ink">Facturas con precio cero · pagos confirmados</div>
          <div className="text-[11px] text-ink-faint">
            {pagadas} de {total} pagadas
            {!data.tablaPagos && ' · el registro de pagos todavía no está habilitado'}
            {data.tablaPagos && !data.puedeRegistrar && ' · sólo facturación y contabilidad registran pagos'}
          </div>
        </div>
        <div className="flex gap-2">
          <FilterButton active={filtro === 'pendientes'} onClick={() => setFiltro('pendientes')}>Por cobrar</FilterButton>
          <FilterButton active={filtro === 'todas'} onClick={() => setFiltro('todas')}>Todas</FilterButton>
        </div>
      </div>

      {facturas.length === 0 ? (
        <p className="text-xs text-ink-faint">
          {total === 0 ? 'No hay facturas con precio cero en el periodo.' : 'Todas las facturas del periodo están pagadas.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-line bg-surface">
          <table className="w-full text-xs">
            <thead className="bg-surface-muted">
              <tr>
                <Th>Fecha</Th>
                <Th>Factura</Th>
                <Th className="hidden md:table-cell">Cliente</Th>
                <Th align="right">Precio cero</Th>
                <Th align="right">Pagado</Th>
                <Th align="right" className="hidden sm:table-cell">Saldo</Th>
                <Th align="center">Estado</Th>
                {data.puedeRegistrar && <Th align="right"> </Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {facturas.map((f) => {
                const k = claveDe(f);
                const open = abierta === k || formAbierto === k;
                return (
                  <Fragment key={k}>
                    <tr className="cursor-pointer hover:bg-surface-hover" onClick={() => setAbierta(abierta === k ? null : k)} aria-expanded={open}>
                      <td className="tabular px-3 py-2 text-ink-muted">{fechaCorta(f.fecha)}</td>
                      <td className="tabular px-3 py-2 text-ink">{f.codigoTransaccion}-{f.documento}</td>
                      <td className="hidden max-w-[16rem] truncate px-3 py-2 text-ink-muted md:table-cell" title={f.cliente}>{f.cliente}</td>
                      <td className="tabular px-3 py-2 text-right text-ink" title={`Precio de lista: ${formatPrice(f.lista)}`}>{formatPrice(f.costo)}</td>
                      <td className="tabular px-3 py-2 text-right text-ink">{f.pagado ? formatPrice(f.pagado) : '—'}</td>
                      <td className={`tabular hidden px-3 py-2 text-right sm:table-cell ${f.saldo > 0 ? 'text-danger' : 'text-ink-faint'}`}>
                        {f.saldo > 0 ? formatPrice(f.saldo) : '—'}
                      </td>
                      <td className="px-3 py-2 text-center"><Badge tone={ESTADO[f.estado].tone}>{ESTADO[f.estado].texto}</Badge></td>
                      {data.puedeRegistrar && (
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            className="whitespace-nowrap rounded border border-accent px-2 py-1 text-[11px] font-medium text-accent hover:bg-surface-hover"
                            onClick={(e) => {
                              e.stopPropagation();
                              setFormAbierto(formAbierto === k ? null : k);
                            }}
                          >
                            Registrar pago
                          </button>
                        </td>
                      )}
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={data.puedeRegistrar ? 8 : 7} className="space-y-3 bg-cream px-3 py-3">
                          {formAbierto === k && <FormPago f={f} onListo={cambio} onCancelar={() => setFormAbierto(null)} />}
                          <PagosFactura f={f} puedeRegistrar={data.puedeRegistrar} onCambio={cambio} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
