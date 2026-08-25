import AppShell from '@/components/AppShell';

/**
 * Ruta propia del P&G. Monta el MISMO shell que la home (sidebar, grupos de
 * menú, layout) con la pestaña de P&G ya activa, en vez de duplicar la
 * navegación. Así /pyg es enlazable y compartible sin que existan dos sidebars.
 */
export default function PygPage() {
  return <AppShell initialTab="pyg" />;
}
