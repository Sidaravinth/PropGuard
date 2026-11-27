import { BrowserRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { AppShell } from "./layout/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { LeaseDetailPage } from "./pages/leases/LeaseDetailPage";
import { LeasesPage } from "./pages/leases/LeasesPage";
import { LoginPage } from "./pages/LoginPage";
import { MaintenancePage } from "./pages/maintenance/MaintenancePage";
import { TicketDetailPage } from "./pages/maintenance/TicketDetailPage";
import { ModulePage, NotFoundPage } from "./pages/ModulePage";
import { PaymentsPage } from "./pages/payments/PaymentsPage";
import { PropertiesPage } from "./pages/properties/PropertiesPage";
import { UnitDetailPage } from "./pages/properties/UnitDetailPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TenantProfilePage } from "./pages/tenants/TenantProfilePage";
import { TenantsPage } from "./pages/tenants/TenantsPage";

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="properties" element={<PropertiesPage />} />
            <Route path="properties/units/:id" element={<UnitDetailPage />} />
            <Route path="tenants" element={<TenantsPage />} />
            <Route path="tenants/:id" element={<TenantProfilePage />} />
            <Route path="leases" element={<LeasesPage />} />
            <Route path="leases/:id" element={<LeaseDetailPage />} />
            <Route path="maintenance" element={<MaintenancePage />} />
            <Route path="maintenance/:id" element={<TicketDetailPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            {/* Built in later groups (Decision Inbox: D, Audit Trail: E). */}
            <Route path="inbox/*" element={<ModulePage />} />
            <Route path="audit/*" element={<ModulePage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
