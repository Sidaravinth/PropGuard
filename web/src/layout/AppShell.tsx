import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, LogOut, Menu, Settings, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { findNavItem, NAV_ITEMS, SETTINGS_ITEM, type NavItem } from "./nav";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

function SidebarLink({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate: () => void }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.path}
      end={item.path === "/"}
      className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
    >
      <Icon size={18} strokeWidth={1.8} aria-hidden />
      <span className="nav-label">{item.label}</span>
    </NavLink>
  );
}

function ProfileMenu() {
  const { profile, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!profile) return null;
  const { user } = profile;
  return (
    <div className="profile-menu" ref={ref}>
      <button className="profile-trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar">{initials(user.display_name)}</span>
        <span className="profile-trigger-text">
          <span className="profile-name">{user.display_name}</span>
          <span className="profile-role">{user.role_label}</span>
        </span>
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-header">
            <div className="profile-name">{user.display_name}</div>
            <div className="muted small">{user.email}</div>
            <span className={`badge role-${user.role}`}>{user.role_label}</span>
          </div>
          <button
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              navigate("/settings");
            }}
          >
            <Settings size={16} aria-hidden /> Settings
          </button>
          <button role="menuitem" className="menu-item danger" onClick={() => void logout()}>
            <LogOut size={16} aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const { profile, logout } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("pg.sidebar.collapsed") === "1");
  const [mobileOpen, setMobileOpen] = useState(false);
  const current = findNavItem(location.pathname);

  useEffect(() => {
    localStorage.setItem("pg.sidebar.collapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    document.title = current ? `${current.label} · PropGuard` : "PropGuard";
  }, [current]);

  const sections = [...new Set(NAV_ITEMS.map((n) => n.section))];
  const closeMobile = () => setMobileOpen(false);

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}${mobileOpen ? " mobile-open" : ""}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="sidebar-brand">
          <Link to="/" className="brand" onClick={closeMobile}>
            <ShieldCheck size={22} aria-hidden />
            <span className="nav-label">
              PROP<strong>guard</strong>
            </span>
          </Link>
          <button className="icon-btn sidebar-close" onClick={closeMobile} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-nav">
          {sections.map((s) => (
            <div key={s} className="nav-section">
              <div className="nav-section-label">{s}</div>
              {NAV_ITEMS.filter((n) => n.section === s).map((item) => (
                <SidebarLink key={item.path} item={item} collapsed={collapsed} onNavigate={closeMobile} />
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <SidebarLink item={SETTINGS_ITEM} collapsed={collapsed} onNavigate={closeMobile} />
          {profile && (
            <div className="sidebar-user" title={collapsed ? `${profile.user.display_name} · ${profile.user.role_label}` : undefined}>
              <span className="avatar">{initials(profile.user.display_name)}</span>
              <span className="nav-label sidebar-user-text">
                <span className="profile-name">{profile.user.display_name}</span>
                <span className="profile-role">{profile.user.role_label}</span>
              </span>
            </div>
          )}
          <button className="nav-link" onClick={() => void logout()} title={collapsed ? "Sign out" : undefined}>
            <LogOut size={18} strokeWidth={1.8} aria-hidden />
            <span className="nav-label">Sign out</span>
          </button>
          <button className="nav-link collapse-toggle" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronsRight size={18} aria-hidden /> : <ChevronsLeft size={18} aria-hidden />}
            <span className="nav-label">Collapse</span>
          </button>
        </div>
      </aside>
      <div className="sidebar-backdrop" onClick={closeMobile} aria-hidden />

      <div className="main">
        <header className="topbar">
          <button className="icon-btn mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu size={20} />
          </button>
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            <Link to="/">PropGuard</Link>
            {current && current.path !== "/" && location.pathname === current.path && (
              <>
                <ChevronRight size={14} aria-hidden />
                <span aria-current="page">{current.label}</span>
              </>
            )}
            {current && current.path !== "/" && location.pathname !== current.path && (
              <>
                <ChevronRight size={14} aria-hidden />
                <Link to={current.path}>{current.label}</Link>
                <ChevronRight size={14} aria-hidden />
                <span aria-current="page">Details</span>
              </>
            )}
            {current?.path === "/" && (
              <>
                <ChevronRight size={14} aria-hidden />
                <span aria-current="page">Dashboard</span>
              </>
            )}
          </nav>
          <div className="topbar-spacer" />
          <ProfileMenu />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
