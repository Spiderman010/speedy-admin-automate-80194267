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
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
      <SidebarTrigger className="-ml-2 h-9 w-9" aria-label="Zijbalk in- of uitklappen" />
      <Separator orientation="vertical" className="mr-2 h-5" />
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
        <span className="truncate text-sm font-semibold">{title}</span>
      )}
    </header>
  );
}
