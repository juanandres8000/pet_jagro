import AppShell from '@/components/AppShell';

/**
 * Ruta propia de Descuentos diferenciados. Monta el MISMO shell que la home con
 * la pestaña activa, igual que /pyg y /comercial: enlazable sin duplicar el sidebar.
 */
export default function DescuentosPage() {
  return <AppShell initialTab="descuentos" />;
}
