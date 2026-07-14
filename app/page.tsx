'use client';

import { useState } from 'react';
import Image from 'next/image';
import PickingView from '@/components/PickingView';
import TrackingView from '@/components/TrackingView';
import FacturacionView from '@/components/FacturacionView';
import LiquidacionesView from '@/components/LiquidacionesView';
import IntegrationsView from '@/components/IntegrationsView';
import ClientesView from '@/components/ClientesView';
import CarteraView from '@/components/CarteraView';
import ChatWidget from '@/components/ChatWidget';
import { Order } from '@/types';
import { mockOrders } from '@/lib/mockData';

type Tab = 'picking' | 'billing' | 'liquidaciones' | 'tracking' | 'clientes' | 'cartera' | 'integrations';

interface MenuItem {
  id: Tab;
  label: string;
  icon: string;
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>('picking');
  const [orders, setOrders] = useState<Order[]>(mockOrders);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Búsqueda prefijada al saltar de Cartera → Clientes (link "Ver cliente").
  const [clientesSearch, setClientesSearch] = useState('');

  const verClienteDesdeCartera = (codigoTercero: string) => {
    setClientesSearch(codigoTercero);
    setActiveTab('clientes');
  };

  const handleUpdateOrder = (updatedOrder: Order) => {
    setOrders(orders.map(o => o.id === updatedOrder.id ? updatedOrder : o));
  };

  const menuItems: MenuItem[] = [
    { id: 'picking', label: 'Picking', icon: '📦' },
    { id: 'billing', label: 'Facturación', icon: '💰' },
    { id: 'liquidaciones', label: 'Liquidaciones', icon: '📋' },
    { id: 'tracking', label: 'Trazabilidad', icon: '🔍' },
    { id: 'clientes', label: 'Clientes', icon: '👥' },
    { id: 'cartera', label: 'Cartera', icon: '💵' },
    { id: 'integrations', label: 'Integraciones', icon: '🔌' },
  ];

  const handleMenuClick = (tabId: Tab) => {
    setActiveTab(tabId);
    setSidebarOpen(false); // Cerrar sidebar en móvil después de seleccionar
  };

  return (
    <div className="flex min-h-screen" style={{ background: '#FFFFFF' }}>
      {/* Mobile Overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-30 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar Vertical */}
      <aside
        className={`
          fixed inset-y-0 left-0 z-50
          lg:sticky lg:top-0 lg:h-screen
          w-64 flex-shrink-0 border-r flex flex-col
          transform transition-transform duration-300 ease-in-out
          lg:overflow-y-auto
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}
        style={{
          background: 'linear-gradient(180deg, #7CB9E8 0%, #5B9BD5 100%)',
          borderColor: '#E2E8F0'
        }}
      >
        {/* Logo Section */}
        <div className="p-6 border-b" style={{ borderColor: 'rgba(255, 255, 255, 0.2)' }}>
          <div className="flex items-center space-x-3">
            <div className="bg-white rounded-lg p-1.5 shadow-sm">
              <Image
                src="/jotagro-logo.png"
                alt="J Agro"
                width={50}
                height={33}
                className="object-contain"
              />
            </div>
            <div>
              <h1 className="text-sm font-bold text-white" style={{ letterSpacing: '-0.3px' }}>
                J AGRO
              </h1>
              <p className="text-xs" style={{ color: 'rgba(255, 255, 255, 0.8)' }}>
                Sistema de Picking
              </p>
            </div>
          </div>
        </div>

        {/* Menu Items */}
        <nav className="flex-1 p-4 space-y-1">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => handleMenuClick(item.id)}
              className="w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-all duration-200 text-left"
              style={
                activeTab === item.id
                  ? {
                      backgroundColor: '#FFFFFF',
                      color: '#5B9BD5',
                      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
                    }
                  : {
                      backgroundColor: 'transparent',
                      color: 'rgba(255, 255, 255, 0.9)',
                    }
              }
              onMouseEnter={(e) => {
                if (activeTab !== item.id) {
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
                }
              }}
              onMouseLeave={(e) => {
                if (activeTab !== item.id) {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }
              }}
            >
              <span className="text-xl">{item.icon}</span>
              <span className="font-medium text-sm">{item.label}</span>
            </button>
          ))}
        </nav>

        {/* User Section at Bottom */}
        <div
          className="p-4 border-t"
          style={{ borderColor: 'rgba(255, 255, 255, 0.2)' }}
        >
          <div className="flex items-center space-x-3 px-2">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm"
              style={{
                backgroundColor: '#FFFFFF',
                color: '#5B9BD5'
              }}
            >
              DC
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-white">
                Administrador
              </p>
              <div className="flex items-center space-x-1.5 mt-0.5">
                <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: '#86EFAC' }}></div>
                <span className="text-xs" style={{ color: 'rgba(255, 255, 255, 0.8)' }}>Conectado</span>
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto flex flex-col" style={{ backgroundColor: '#F8FAFC' }}>
        {/* Mobile Header with Hamburger */}
        <div
          className="lg:hidden flex items-center justify-between px-4 py-3 border-b sticky top-0 z-30"
          style={{
            backgroundColor: '#FFFFFF',
            borderColor: '#E2E8F0'
          }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 rounded-lg transition-colors"
            style={{ color: '#7CB9E8' }}
          >
            <svg
              className="w-6 h-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          <div className="flex items-center space-x-2">
            <Image
              src="/jotagro-logo.png"
              alt="J Agro"
              width={40}
              height={26}
              className="object-contain"
            />
            <h1 className="text-sm font-bold" style={{ color: '#7CB9E8' }}>
              J AGRO
            </h1>
          </div>
          <div className="w-10"></div>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 sm:p-6 lg:p-8">
          {activeTab === 'picking' && <PickingView orders={orders} onUpdateOrder={handleUpdateOrder} />}
          {activeTab === 'billing' && <FacturacionView orders={orders} onUpdateOrder={handleUpdateOrder} />}
          {activeTab === 'liquidaciones' && <LiquidacionesView />}
          {activeTab === 'tracking' && <TrackingView orders={orders} />}
          {activeTab === 'clientes' && <ClientesView initialSearch={clientesSearch} />}
          {activeTab === 'cartera' && <CarteraView onVerCliente={verClienteDesdeCartera} />}
          {activeTab === 'integrations' && <IntegrationsView />}
        </div>
      </main>

      {/* AI Chat Widget */}
      <ChatWidget />
    </div>
  );
}
