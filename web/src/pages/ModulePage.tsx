import { useLocation } from "react-router";
import { Card, EmptyState, PageHeader } from "../components/ui";
import { findNavItem } from "../layout/nav";

/** Shell for a module whose screens are built in a later group. Shows no data, real or fake. */
export function ModulePage() {
  const item = findNavItem(useLocation().pathname)!;
  return (
    <>
      <PageHeader title={item.label} description={item.description} />
      <Card>
        <EmptyState icon={item.icon} title={`${item.label} is not built yet`}>
          This module is part of the next implementation group.
        </EmptyState>
      </Card>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" description="The page you were looking for does not exist." />
    </>
  );
}
