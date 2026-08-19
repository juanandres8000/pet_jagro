# 🔧 Notas de Desarrollo - Sistema J Agro

Documento técnico con decisiones de diseño, pendientes y consideraciones para desarrollo futuro.

---

## 🏗️ Arquitectura Actual

### Stack Tecnológico
```
Frontend:
├── Next.js 14.2.33 (App Router)
├── React 18
├── TypeScript 5
├── Tailwind CSS 3
└── date-fns (localización español)

Estado:
├── React useState (local)
├── Props drilling (padre → hijo)
└── Context API (solo para tema)

Datos:
└── Mock data en memoria (lib/mockData.ts)

Hosting:
└── Vercel (deployment automático)
```

---

## 📁 Organización de Archivos

### Convenciones Actuales
```
components/
  ├── [NombreVista]View.tsx     # Vistas principales
  ├── [NombreComponente].tsx    # Componentes reutilizables
  └── Naming: PascalCase

types/
  └── index.ts                  # Todos los tipos centralizados

lib/
  └── mockData.ts               # Datos de prueba
  └── (futuro) api.ts           # Llamadas a API

contexts/
  └── ThemeContext.tsx          # Solo tema por ahora
  └── (futuro) AuthContext.tsx  # Autenticación
```

### Reglas de Importación
```typescript
// ✅ Correcto
import { Order } from '@/types';
import OrderDetail from '@/components/OrderDetail';
import { mockOrders } from '@/lib/mockData';

// ❌ Evitar
import { Order } from '../../../types';
import OrderDetail from './components/OrderDetail';
```

---

## 🔄 Flujo de Datos Actual

### Gestión de Estado (v1.3.0)
```
app/page.tsx (padre)
  ↓
  ├── orders: Order[]              [useState]
  ├── handleUpdateOrder()          [función]
  │
  ├─→ PickingView
  │     ├── orders (prop)
  │     ├── onUpdateOrder (prop)
  │     └── selectedOrder (local state)
  │
  ├─→ FacturacionView
  │     ├── orders (prop)
  │     ├── onUpdateOrder (prop)
  │     └── selectedOrder (local state)
  │
  └─→ TrackingView
        └── orders (prop)
```

### ⚠️ Limitaciones Actuales
1. **No hay persistencia**: Los datos se pierden al recargar
2. **Props drilling**: Puede volverse complejo con más niveles
3. **Sin sincronización**: Múltiples usuarios verían datos desactualizados

---

## 🎨 Sistema de Temas

### Implementación
```typescript
// ThemeContext.tsx
export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState<Theme>('light');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // 1. Cargar de localStorage
    const saved = localStorage.getItem('theme');

    // 2. O detectar preferencia del sistema
    if (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      setTheme('dark');
    }
  }, []);

  // Aplicar clase 'dark' al <html>
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);
}
```

### Uso en Componentes
```typescript
// ✅ Correcto
<div className="bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100">

// ❌ Evitar crear componentes separados para cada tema
```

---

## 🔐 Preparación para Azure

### Próximos Pasos
1. **Autenticación (Azure AD B2C)**
```typescript
// contexts/AuthContext.tsx (futuro)
interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'picker' | 'billing' | 'manager';
  tenantId: string;
}

// Proteger rutas
export function ProtectedRoute({ children, allowedRoles }) {
  const { user, loading } = useAuth();

  if (loading) return <Loading />;
  if (!user) return <Redirect to="/login" />;
  if (!allowedRoles.includes(user.role)) return <Unauthorized />;

  return children;
}
```

2. **API Layer**
```typescript
// lib/api.ts (futuro)
const API_URL = process.env.NEXT_PUBLIC_API_URL;

export async function getOrders(): Promise<Order[]> {
  const res = await fetch(`${API_URL}/orders`, {
    headers: {
      'Authorization': `Bearer ${getToken()}`
    }
  });
  return res.json();
}

export async function updateOrderStatus(
  orderId: string,
  status: OrderStatus
): Promise<Order> {
  const res = await fetch(`${API_URL}/orders/${orderId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status })
  });
  return res.json();
}
```

3. **Base de Datos (Azure SQL)**
```sql
-- Esquema básico propuesto

CREATE TABLE Orders (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    orderNumber NVARCHAR(50) UNIQUE NOT NULL,
    customerName NVARCHAR(255) NOT NULL,
    customerPhone NVARCHAR(20),
    customerAddress NVARCHAR(500),
    status NVARCHAR(50) NOT NULL,
    priority NVARCHAR(20) NOT NULL,
    totalValue DECIMAL(18,2) NOT NULL,
    assignedTo UNIQUEIDENTIFIER,
    createdAt DATETIME2 DEFAULT GETDATE(),
    assignedAt DATETIME2,
    completedAt DATETIME2,
    CONSTRAINT FK_Orders_Users FOREIGN KEY (assignedTo)
        REFERENCES Users(id)
);

CREATE TABLE OrderItems (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    orderId UNIQUEIDENTIFIER NOT NULL,
    productId UNIQUEIDENTIFIER NOT NULL,
    quantity INT NOT NULL,
    scannedQuantity INT DEFAULT 0,
    scanned BIT DEFAULT 0,
    scannedAt DATETIME2,
    CONSTRAINT FK_OrderItems_Orders FOREIGN KEY (orderId)
        REFERENCES Orders(id) ON DELETE CASCADE,
    CONSTRAINT FK_OrderItems_Products FOREIGN KEY (productId)
        REFERENCES Products(id)
);

CREATE TABLE Products (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    name NVARCHAR(255) NOT NULL,
    barcode NVARCHAR(50) UNIQUE NOT NULL,
    category NVARCHAR(50) NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    minStock INT NOT NULL DEFAULT 0,
    price DECIMAL(18,2) NOT NULL,
    supplier NVARCHAR(255),
    lastUpdated DATETIME2 DEFAULT GETDATE()
);

CREATE TABLE Users (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    email NVARCHAR(255) UNIQUE NOT NULL,
    name NVARCHAR(255) NOT NULL,
    role NVARCHAR(50) NOT NULL,
    tenantId NVARCHAR(255),
    createdAt DATETIME2 DEFAULT GETDATE()
);
```

---

## 🚨 Problemas Conocidos y Soluciones

### 1. SSR y Client-Side Hooks
**Problema**: Hooks como `useTheme` causan error en SSR
```
Error: useTheme debe usarse dentro de ThemeProvider
```

**Solución Aplicada**:
```typescript
export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    // Retornar valores seguros para SSR
    return {
      theme: 'light' as Theme,
      toggleTheme: () => {},
    };
  }
  return context;
}
```

### 2. Formato de Fechas en Español
**Problema**: Fechas en inglés por defecto

**Solución**:
```typescript
import { format } from 'date-fns';
import { es } from 'date-fns/locale';

format(date, "d 'de' MMMM, HH:mm", { locale: es });
// Output: "30 de octubre, 14:30"
```

### 3. Moneda Colombiana
```typescript
const formatPrice = (price: number) => {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0, // Sin centavos
  }).format(price);
};
// Output: "$830.000"
```

---

## 🎯 Mejoras Pendientes

### Prioridad Alta
- [ ] **Persistencia de datos**
  - Migrar de mock data a API real
  - Implementar llamadas a backend
  - Manejo de errores y loading states

- [ ] **Autenticación y autorización**
  - Azure AD B2C integration
  - Roles y permisos
  - Protección de rutas

- [ ] **Gestión de estado escalable**
  - Considerar Zustand o Redux
  - Caché de datos (React Query/SWR)
  - Optimistic updates

### Prioridad Media
- [ ] **Scanner real de códigos**
  - Integración con cámara del dispositivo
  - Librería: html5-qrcode o zxing
  - Fallback a manual si falla

- [ ] **Notificaciones**
  - Push notifications para nuevos pedidos
  - Alertas de stock bajo
  - Confirmaciones de acciones

- [ ] **Exportación de datos**
  - Reportes en PDF
  - Exportar a Excel
  - Histórico de pedidos

### Prioridad Baja
- [ ] **Optimizaciones de rendimiento**
  - Lazy loading de componentes
  - Virtualización de listas largas
  - Imágenes optimizadas

- [ ] **Tests**
  - Unit tests (Jest + React Testing Library)
  - E2E tests (Playwright/Cypress)
  - Coverage > 80%

- [ ] **Accesibilidad**
  - ARIA labels
  - Navegación por teclado
  - Contraste WCAG AA

---

## 🔍 Decisiones de Diseño

### ¿Por qué Next.js App Router?
- SSR para mejor SEO (futuro landing page)
- File-based routing simplificado
- Server Components para optimización
- Fácil deployment en Vercel

### ¿Por qué Tailwind CSS?
- Desarrollo rápido con utility classes
- Modo oscuro built-in (`dark:`)
- Tree-shaking automático (CSS pequeño)
- Responsive design fácil

### ¿Por qué TypeScript?
- Autocompletado en IDE
- Detección temprana de errores
- Documentación viva (interfaces)
- Refactoring seguro

### ¿Por qué Context API (no Redux)?
- Necesidad simple (solo tema)
- Menos boilerplate
- Built-in en React
- Si crece, migrar a Zustand

---

## 📊 Métricas a Monitorear (Futuro)

### Performance
- Lighthouse score > 90
- First Contentful Paint < 1.5s
- Time to Interactive < 3s
- Cumulative Layout Shift < 0.1

### Negocio
- Tiempo promedio por pedido
- Tasa de error de picking
- Pedidos procesados por hora
- Stock outs prevenidos

### Usuarios
- Sesiones activas simultáneas
- Tasa de adopción por picker
- Tiempo de capacitación
- Satisfacción (NPS)

---

## 🔐 Seguridad (Checklist Futuro)

- [ ] HTTPS obligatorio
- [ ] Headers de seguridad (CSP, HSTS)
- [ ] Sanitización de inputs
- [ ] Rate limiting en API
- [ ] Tokens JWT con expiración
- [ ] Logs de auditoría
- [ ] Backup automático de DB
- [ ] Encriptación de datos sensibles
- [ ] 2FA para roles admin

---

## 📝 Comandos Útiles

### Desarrollo
```bash
npm run dev          # Servidor desarrollo (port 3000)
npm run build        # Build producción
npm run start        # Servidor producción
npm run lint         # ESLint check
```

### Git
```bash
git status           # Ver cambios
git add .            # Agregar todos
git commit -m "msg"  # Commit
git push             # Push a GitHub
```

### Vercel
```bash
vercel               # Deploy preview
vercel --prod        # Deploy producción
vercel logs          # Ver logs
```

---

## 🤝 Convenciones de Código

### Commits
Formato: `[tipo]: descripción corta`

Tipos:
- `feat`: Nueva funcionalidad
- `fix`: Corrección de bug
- `docs`: Cambios en documentación
- `style`: Formato, punto y coma, etc.
- `refactor`: Refactorización de código
- `test`: Agregar o corregir tests
- `chore`: Tareas de mantenimiento

Ejemplo:
```bash
git commit -m "feat: agregar vista de facturación"
git commit -m "fix: corregir visibilidad de contador en modo claro"
```

### Nombrado
```typescript
// Componentes: PascalCase
export default function PickingView() {}

// Funciones: camelCase
const handleUpdateOrder = () => {}

// Constantes: UPPER_SNAKE_CASE
const API_URL = "https://api.jagro.com"

// Tipos/Interfaces: PascalCase
interface Order {}
type OrderStatus = "pending" | "in_progress"
```

---

## 🎓 Recursos de Aprendizaje

### Next.js
- [Documentación oficial](https://nextjs.org/docs)
- [App Router Guide](https://nextjs.org/docs/app)

### TypeScript
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [React + TypeScript Cheatsheet](https://react-typescript-cheatsheet.netlify.app/)

### Tailwind
- [Tailwind Docs](https://tailwindcss.com/docs)
- [Tailwind UI Components](https://tailwindui.com/)

### Azure
- [Azure AD B2C](https://docs.microsoft.com/azure/active-directory-b2c/)
- [Azure SQL Database](https://docs.microsoft.com/azure/azure-sql/)

---

## 📞 Contactos Clave

### Técnico
- **Repositorio**: https://github.com/juanandres8000/pet_jagro
- **Issues**: GitHub Issues
- **Deployment**: Vercel Dashboard

### Negocio
- **Cliente**: J Agro, Colombia
- **Usuarios Finales**: Pickers, Facturación, Managers

---

**Última actualización**: 30 de Octubre, 2025
**Versión Actual**: 1.3.0
**Estado**: ✅ En Producción (MVP)
