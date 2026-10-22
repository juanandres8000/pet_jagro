import AppShell from '@/components/AppShell';

/**
 * Ruta propia del apartado Comercial (vendedores). Monta el MISMO shell que la
 * home con la pestaña Comercial activa, igual que /pyg: enlazable sin duplicar
 * el sidebar.
 */
export default function ComercialPage() {
  return <AppShell initialTab="comercial" />;
}
