'use client';

import { useState } from 'react';
import Image from 'next/image';
import GerenciaView from '@/components/GerenciaView';
import PygView from '@/components/PygView';
import PickingView from '@/components/PickingView';
import InventarioView from '@/components/InventarioView';
import CatalogoView from '@/components/CatalogoView';
import ClientesView from '@/components/ClientesView';
import CarteraView from '@/components/CarteraView';
import ComposicionView from '@/components/ComposicionView';
import VendedoresView from '@/components/VendedoresView';

type Tab = 'gerencia' | 'pyg' | 'picking' | 'inventario' | 'catalogo' | 'clientes' | 'cartera' | 'composicion' | 'vendedores';

interface MenuItem {
  id: Tab;
  label: string;
}

interface MenuGroup {
  label: string;
  items: MenuItem[];
}

// Facturación, Liquidaciones y Trazabilidad quedaron fuera del producto:
// no tienen entrada de nav ni rama de render, así que son inalcanzables.
// Inventario y Catálogo sustituyen a la antigua Trazabilidad sobre la misma
// fuente real (/api/productos).
const MENU_GROUPS: MenuGroup[] = [
  {
    label: 'Dirección',
    items: [
      { id: 'gerencia', label: 'Gerencia' },
      { id: 'pyg', label: 'P&G' },
    ],
  },
  // OPERACIÓN OCULTA — ver CLAUDE.md § "Operación oculta".
  // A diferencia de Facturación/Liquidaciones/Trazabilidad, aquí sólo se quita
  // la entrada de nav: las ramas de render de picking/inventario/catalogo y sus
  // componentes siguen montados abajo y compilan. Descomentar este bloque
  // devuelve los tres módulos al menú sin tocar nada más.
  // {
  //   label: 'Operación',
  //   items: [
  //     { id: 'picking', label: 'Picking' },
  //     { id: 'inventario', label: 'Inventario' },
  //     { id: 'catalogo', label: 'Catálogo' },
  //   ],
  // },
  {
    label: 'Comercial',
    items: [{ id: 'clientes', label: 'Clientes' }],
  },
  {
    label: 'Finanzas',
    items: [
      { id: 'cartera', label: 'Cartera' },
      { id: 'vendedores', label: 'Vendedores' },
      // COMPOSICIÓN OCULTA — mismo patrón que Operación: se quita la entrada de
      // nav, la rama de render y el componente siguen montados abajo.
      // Su premisa no existe en esta instancia: el ERP clasifica TODA la cartera
      // en una sola clase (0, GENERAL), así que un menú "Composición" prometía un
      // desglose inexistente. El hallazgo que sí valía —los saldos a favor— vive
      // ahora en Cartera, que es donde se busca.
      // Si el ERP empieza a clasificar, descomentar esta línea devuelve la vista
      // completa (gráfico de barras divergentes incluido) sin reconstruir nada.
      // { id: 'composicion', label: 'Composición' },
    ],
  },
];

export default function AppShell({ initialTab = 'gerencia' }: { initialTab?: Tab }) {
  // Gerencia es la home: es la lectura que abre el dashboard. `initialTab` deja
  // que una ruta propia (app/pyg) monte este mismo shell con otra pestaña activa
  // sin duplicar el sidebar.
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Búsqueda prefijada al saltar de Cartera → Clientes (link "Ver cliente").
  const [clientesSearch, setClientesSearch] = useState('');

  const verClienteDesdeCartera = (codigoTercero: string) => {
    setClientesSearch(codigoTercero);
    setActiveTab('clientes');
  };

  const handleMenuClick = (tabId: Tab) => {
    setActiveTab(tabId);
    setSidebarOpen(false);
  };

  return (
    <div className="flex min-h-screen bg-cream">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-ink/20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside
        className={`
          fixed inset-y-0 left-0 z-50 flex w-64 flex-shrink-0 flex-col
          border-r border-line bg-surface
          transition-transform duration-300 ease-in-out
          lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:overflow-y-auto
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        <div className="border-b border-line px-6 py-6">
          <div className="flex items-center gap-3">
            <Image src="/jotagro-logo.png" alt="J Agro" width={36} height={24} className="object-contain" />
            <div>
              <h1 className="font-serif text-lg font-semibold tracking-tight text-ink">J Agro</h1>
              <p className="text-xs text-ink-muted">Sistema de Picking</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-8 px-4 py-8">
          {MENU_GROUPS.map(group => (
            <div key={group.label}>
              <div className="px-3 text-xs font-medium uppercase tracking-widest text-ink-faint">
                {group.label}
              </div>
              <div className="mt-3 space-y-0.5">
                {group.items.map(item => {
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => handleMenuClick(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? 'bg-accent font-medium text-ink-inverse'
                          : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
              DC
            </div>
            <div>
              <p className="text-sm font-medium text-ink">Administrador</p>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                <span className="text-xs text-ink-muted">Conectado</span>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded p-2 text-ink-muted transition-colors hover:bg-surface-hover"
            aria-label="Abrir menú"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <Image src="/jotagro-logo.png" alt="J Agro" width={32} height={21} className="object-contain" />
            <span className="font-serif text-base font-semibold text-ink">J Agro</span>
          </div>
          <div className="w-9" />
        </div>

        <div className="flex-1 px-4 py-8 sm:px-8 lg:px-12">
          <div className="mx-auto max-w-6xl">
            {activeTab === 'gerencia' && <GerenciaView />}
            {activeTab === 'pyg' && <PygView />}
            {activeTab === 'picking' && <PickingView />}
            {activeTab === 'inventario' && <InventarioView />}
            {activeTab === 'catalogo' && <CatalogoView />}
            {activeTab === 'clientes' && <ClientesView initialSearch={clientesSearch} />}
            {activeTab === 'cartera' && <CarteraView onVerCliente={verClienteDesdeCartera} />}
            {activeTab === 'composicion' && <ComposicionView />}
            {activeTab === 'vendedores' && <VendedoresView />}
          </div>
        </div>
      </main>
    </div>
  );
}
