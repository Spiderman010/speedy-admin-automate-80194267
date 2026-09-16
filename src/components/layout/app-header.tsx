import { Link, useLocation } from "react-router-dom";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { pageTitleForPath, parentNavItemForPath } from "./nav";

/**
 * Compact shell header: sidebar toggle + current page title. Nested routes
 * (e.g. /facturen/inkoop/:id) get a small breadcrumb back to their parent.
 * Page-specific titles/actions stay in the pages' own PageHeader.
 */
export function AppHeader() {
  const location = useLocation();
  const title = pageTitleForPath(location.pathname);
  const parent = parentNavItemForPath(location.pathname);

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-card/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/90 sm:px-5">
      <SidebarTrigger className="-ml-2 h-9 w-9" aria-label="Zijbalk in- of uitklappen" />
      <Separator orientation="vertical" className="mr-1 h-4" />
      {parent ? (
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={parent.url}>{parent.title}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Details</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      ) : (
        <span className="truncate text-sm font-medium text-muted-foreground">{title}</span>
      )}
    </header>
  );
}
