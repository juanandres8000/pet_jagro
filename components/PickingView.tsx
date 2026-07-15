'use client';

import { useState, useEffect } from 'react';
import { Order } from '@/types';
import OrderDetail from './OrderDetail';
import { format } from 'date-fns';
import { es } from 'date-fns/locale';
import { pedidoToOrder, hayFaltante } from '@/lib/hgi/adapters/pedidoToOrder';
import type { Pedido } from '@/lib/hgi/mappers/pedidos';
import type { Cliente } from '@/lib/hgi/mappers/terceros';
import type { CarteraCliente } from '@/lib/hgi/mappers/cartera';
import {
  PageHeader,
  SectionTitle,
  Card,
  KpiCard,
  Badge,
  FilterButton,
  Th,
  EmptyState,
} from '@/components/ui';
import { formatPrice, kpiMoney } from '@/lib/format';

export default function PickingView() {
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  // Fuente REAL: pedidos pendientes de HGINet (vía adaptador Pedido→Order).
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Filtro de pedidos stale: por defecto se muestran (toggle ON) porque hoy el
  // 100% de pendientes es de ene-2020; al apagarlo se ocultan los < CORTE.
  const [verHistoricos, setVerHistoricos] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Pedidos + clientes + cartera en paralelo; clientes enriquece
        // teléfono/dirección y alerta; cartera aporta el saldo vencido.
        const [pedRes, cliRes, carRes] = await Promise.all([
          fetch('/api/pedidos'),
          fetch('/api/clientes'),
          fetch('/api/cartera'),
        ]);
        const ped = await pedRes.json();
        const cli = await cliRes.json();
        if (cancelled) return;
        if (!pedRes.ok || !ped.ok) {
          setError(ped?.mensaje || `Error ${pedRes.status} al cargar pedidos`);
          return;
        }
        const clientesById = new Map<string, Cliente>();
        if (cli?.ok && Array.isArray(cli.clientes)) {
          for (const c of cli.clientes as Cliente[]) clientesById.set(c.id, c);
        }
        const carteraByTercero = new Map<string, CarteraCliente>();
        try {
          const car = await carRes.json();
          if (car?.ok && Array.isArray(car.clientes)) {
            for (const c of car.clientes as CarteraCliente[]) carteraByTercero.set(c.codigoTercero, c);
          }
        } catch {
          /* cartera opcional */
        }
        const adapted = (ped.pedidos as Pedido[]).map((p) => pedidoToOrder(p, clientesById, carteraByTercero));
        setOrders(adapted);
        setAviso(ped.aviso ?? null);
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

  // Corte de "históricos": pedidos con fecha anterior a 2021-01-01 se consideran
  // stale y se ocultan cuando el toggle "Ver históricos" está apagado.
  const CORTE_HISTORICO = new Date('2021-01-01T00:00:00');
  const esHistorico = (o: Order) => o.createdAt < CORTE_HISTORICO;
  const historicosCount = orders.filter(esHistorico).length;
  const visibleOrders = verHistoricos ? orders : orders.filter((o) => !esHistorico(o));

  // Estados que lista el Picking, en orden de aparición. `completed` es el
  // estado terminal del flujo; `ready_for_billing` ya no se puede alcanzar
  // (Facturación se retiró) pero se sigue listando para que los pedidos que
  // quedaran en ese estado no desaparezcan sin destino.
  const PICKING_STATUSES = ['in_progress', 'pending', 'completed', 'ready_for_billing'] as const;

  const STATUS_META: Record<
    (typeof PICKING_STATUSES)[number],
    { label: string; tone: 'accent' | 'neutral'; fecha: (d: Date) => string }
  > = {
    in_progress: { label: 'En proceso', tone: 'accent', fecha: (d) => format(d, 'HH:mm', { locale: es }) },
    pending: { label: 'Pendiente', tone: 'neutral', fecha: (d) => format(d, 'd MMM HH:mm', { locale: es }) },
    completed: { label: 'Completado', tone: 'accent', fecha: (d) => format(d, 'd MMM HH:mm', { locale: es }) },
    ready_for_billing: { label: 'Listo para facturar', tone: 'neutral', fecha: (d) => format(d, 'd MMM HH:mm', { locale: es }) },
  };

  const byStatus = (s: (typeof PICKING_STATUSES)[number]) => visibleOrders.filter((o) => o.status === s);
  const pendingOrders = byStatus('pending');
  const inProgressOrders = byStatus('in_progress');
  const activeOrders = PICKING_STATUSES.flatMap(byStatus);

  if (selectedOrder) {
    return (
      <OrderDetail
        order={selectedOrder}
        onBack={() => setSelectedOrder(null)}
        onUpdate={(updatedOrder) => {
          setOrders((prev) => prev.map((o) => (o.id === updatedOrder.id ? updatedOrder : o)));
          setSelectedOrder(updatedOrder);
        }}
      />
    );
  }

  /** Capa visual: badges de alerta de un pedido. La condición de cada uno no cambia. */
  const orderBadges = (order: Order) => (
    <div className="flex flex-wrap items-center gap-1.5">
      {order.customer.alertaCartera && (
        <span title={order.customer.motivoAlerta ?? 'Cliente con alerta de cartera'}>
          <Badge tone="danger">Cartera</Badge>
        </span>
      )}
      {(order.customer.saldoVencido ?? 0) > 0 && (
        <span title={`Días máx mora: ${order.customer.diasMaxMora ?? 0}`}>
          <Badge tone="warn">
            <span className="tabular">{formatPrice(order.customer.saldoVencido ?? 0)}</span>
            <span className="ml-1">vencido</span>
          </Badge>
        </span>
      )}
      {hayFaltante(order) && (
        <span title="Algún ítem pide más de lo disponible en stock">
          <Badge tone="danger">Stock insuficiente</Badge>
        </span>
      )}
    </div>
  );

  /** Capa visual: una fila de pedido. `fecha` conserva el formato de cada grupo. */
  const orderRow = (order: Order, estado: string, tone: 'accent' | 'neutral', fecha: string) => (
    <tr
      key={order.id}
      onClick={() => setSelectedOrder(order)}
      className="cursor-pointer transition-colors hover:bg-surface-hover"
    >
      <td className="px-4 py-4 align-top">
        <span className="tabular font-medium text-ink">{order.orderNumber}</span>
      </td>
      <td className="px-4 py-4 align-top">
        <div className="text-sm text-ink">{order.customer.name}</div>
        <div className="mt-1 text-xs text-ink-faint" suppressHydrationWarning>
          <span className="tabular">{order.items.length}</span> items · <span className="tabular">{fecha}</span>
        </div>
      </td>
      <td className="px-4 py-4 align-top">
        <Badge tone={tone}>{estado}</Badge>
      </td>
      <td className="px-4 py-4 align-top">{orderBadges(order)}</td>
      <td className="px-4 py-4 text-right align-top">
        <span className="tabular font-medium text-ink">{formatPrice(order.totalValue)}</span>
      </td>
    </tr>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Picking"
        subtitle={
          <>
            {loading && <span className="block">Cargando pedidos pendientes desde HGINet…</span>}
            {error && (
              <span className="block text-danger">No se pudieron cargar los pedidos: {error}</span>
            )}
            {aviso && <span className="block text-warn">{aviso}</span>}
            {!loading && !error && !aviso && (
              <span className="block">Pedidos pendientes y en curso desde HGINet.</span>
            )}
          </>
        }
      />

      {/* Indicadores */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <KpiCard label="Pendientes" value={pendingOrders.length} />
        <KpiCard label="En curso" value={inProgressOrders.length} tone="accent" />
        <KpiCard
          {...kpiMoney(pendingOrders.reduce((sum, o) => sum + o.totalValue, 0))}
          label="Valor total"
          hint="Suma de pedidos pendientes"
        />
      </div>

      {/* Lista de pedidos */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Pedidos activos</SectionTitle>
          <div className="flex items-center gap-3">
            {historicosCount > 0 && (
              <span title="Pedidos con fecha anterior al 2021-01-01 (stale). Actívalo para verlos.">
                <FilterButton active={verHistoricos} onClick={() => setVerHistoricos((v) => !v)}>
                  Ver históricos (<span className="tabular">{historicosCount}</span>)
                </FilterButton>
              </span>
            )}
            <div className="text-sm text-ink-muted">
              <span className="tabular">{activeOrders.length}</span> total
            </div>
          </div>
        </div>

        <Card className="overflow-hidden">
          {activeOrders.length === 0 ? (
            <EmptyState title="No hay pedidos activos" hint="Los pedidos pendientes aparecerán aquí." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead className="bg-surface-muted">
                  <tr className="border-b border-line">
                    <Th>Pedido</Th>
                    <Th>Cliente</Th>
                    <Th>Estado</Th>
                    <Th>Alertas</Th>
                    <Th align="right">Valor</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {activeOrders.map((order) => {
                    const meta = STATUS_META[order.status as (typeof PICKING_STATUSES)[number]];
                    return orderRow(order, meta.label, meta.tone, meta.fecha(order.createdAt));
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
