import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, History, Users, Briefcase, Settings, LogOut, ShieldCheck, FileStack, KeyRound } from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

const userItems = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "History", url: "/history", icon: History },
];

const adminItems = [
  { title: "Overview", url: "/admin", icon: ShieldCheck },
  { title: "Users", url: "/admin/users", icon: Users },
  { title: "All Jobs", url: "/admin/jobs", icon: Briefcase },
  { title: "Turnitin", url: "/admin/turnitin", icon: KeyRound },
  { title: "Portal Configs", url: "/admin/portals", icon: Settings },
];

export function AppSidebar() {
  const { isAdmin, profile, signOut } = useAuth();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <FileStack className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold">Document Hub</span>
            <span className="text-xs text-muted-foreground">Processing</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {userItems.map((i) => (
                <SidebarMenuItem key={i.url}>
                  <SidebarMenuButton asChild isActive={pathname === i.url}>
                    <Link to={i.url}>
                      <i.icon /><span>{i.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminItems.map((i) => (
                  <SidebarMenuItem key={i.url}>
                    <SidebarMenuButton asChild isActive={pathname === i.url}>
                      <Link to={i.url}>
                        <i.icon /><span>{i.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t p-3">
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:hidden">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{profile?.full_name || profile?.email}</p>
            <p className="truncate text-[10px] uppercase text-muted-foreground">{profile?.role}</p>
          </div>
          <Button variant="ghost" size="icon" onClick={signOut}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
