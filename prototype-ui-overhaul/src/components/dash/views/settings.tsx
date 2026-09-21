"use client";

import { useState } from "react";
import { useDash } from "@/lib/dash/store";
import { USERS, INITIAL_AUDIT, fmtRelativeTime } from "@/lib/dash/mock-data";
import { Panel, PageHeader, FilterPills } from "../shared/primitives";
import { StatusBadge } from "../shared/status-badge";
import { DataTable, type Column } from "../shared/data-table";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { ShieldCheck, ShieldPlus, UserPlus, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { User, AuditEntry, UserRole } from "@/lib/dash/types";

const HUES: Record<string, string> = {
  blue: "linear-gradient(135deg,#3b82f6,#2563eb)",
  emerald: "linear-gradient(135deg,#10b981,#059669)",
  amber: "linear-gradient(135deg,#f59e0b,#d97706)",
  purple: "linear-gradient(135deg,#a855f7,#9333ea)",
};

const ROLE_PILLS = [
  { value: "all", label: "All roles" },
  { value: "admin", label: "Admin" },
  { value: "operator", label: "Operator" },
  { value: "viewer", label: "Viewer" },
];

export function SettingsView() {
  const auditFromStore = useDash((s) => s.audit);
  const appendAudit = useDash((s) => s.appendAudit);
  const currentUser = useDash((s) => s.currentUser);
  const [users, setUsers] = useState<User[]>(USERS);
  const [roleFilter, setRoleFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);

  const [newName, setNewName] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<UserRole>("viewer");

  // Combine seeded audit + session audit
  const audit: AuditEntry[] = [...auditFromStore, ...INITIAL_AUDIT];

  const visibleUsers = roleFilter === "all" ? users : users.filter((u) => u.role === roleFilter);

  function addUser() {
    if (!newName.trim() || !newUsername.trim()) {
      toast.error("Name and username required");
      return;
    }
    const initials = newName.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    const hue = ["blue", "emerald", "amber", "purple"][users.length % 4]!;
    const u: User = {
      id: `u-${users.length + 1}`,
      username: newUsername.trim().toLowerCase(),
      displayName: newName.trim(),
      role: newRole,
      initials,
      hue,
      lastActive: new Date().toISOString(),
      twoFactor: false,
    };
    setUsers((p) => [...p, u]);
    appendAudit({
      action: "Created user",
      target: `${u.username} → ${u.role}`,
      ip: "10.0.4.22",
    });
    toast.success(`Added ${u.displayName}`, { description: `@${u.username} has ${u.role} permissions.` });
    setAddOpen(false);
    setNewName("");
    setNewUsername("");
    setNewRole("viewer");
  }

  function changeRole(userId: string, role: UserRole) {
    setUsers((p) => p.map((u) => (u.id === userId ? { ...u, role } : u)));
    const u = users.find((x) => x.id === userId);
    if (u) {
      appendAudit({
        action: "Updated user role",
        target: `${u.username} → ${role}`,
        ip: "10.0.4.22",
      });
      toast.success(`Role updated`, { description: `${u.displayName} is now ${role}.` });
    }
  }

  const userCols: Column<User>[] = [
    {
      key: "user", header: "User", mobileFullWidth: true,
      cell: (u) => (
        <div className="flex items-center gap-2.5">
          <div
            className="size-8 rounded-full grid place-items-center text-white text-xs font-semibold shrink-0"
            style={{ background: HUES[u.hue] }}
          >
            {u.initials}
          </div>
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{u.displayName}</div>
            <div className="text-xs text-muted-foreground truncate">@{u.username}</div>
          </div>
        </div>
      ),
      rawValue: (u) => `${u.displayName} @${u.username}`,
    },
    {
      key: "role", header: "Role",
      cell: (u) => (
        <select
          value={u.role}
          onChange={(e) => changeRole(u.id, e.target.value as UserRole)}
          disabled={u.id === currentUser?.id}
          className="text-xs bg-muted/40 border border-border rounded px-2 py-1 capitalize disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="admin">admin</option>
          <option value="operator">operator</option>
          <option value="viewer">viewer</option>
        </select>
      ),
      rawValue: (u) => u.role,
    },
    {
      key: "2fa", header: "2FA",
      cell: (u) => u.twoFactor ? (
        <span className="text-xs flex items-center gap-1 text-emerald-500"><ShieldCheck className="size-3" /> On</span>
      ) : (
        <span className="text-xs flex items-center gap-1 text-muted-foreground"><ShieldPlus className="size-3" /> Off</span>
      ),
      rawValue: (u) => (u.twoFactor ? "on" : "off"),
    },
    {
      key: "active", header: "Last active",
      cell: (u) => <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(u.lastActive)}</span>,
      rawValue: (u) => u.lastActive,
    },
    {
      key: "id", header: "User ID", hideOnMobile: true,
      cell: (u) => <span className="font-mono text-[10px] text-muted-foreground">{u.id}</span>,
      rawValue: (u) => u.id,
    },
  ];

  const auditCols: Column<AuditEntry>[] = [
    {
      key: "username", header: "User", mobileFullWidth: true,
      cell: (a) => <span className="font-mono text-xs">@{a.username}</span>,
      rawValue: (a) => a.username,
    },
    {
      key: "action", header: "Action",
      cell: (a) => <span className="text-sm">{a.action}</span>,
      rawValue: (a) => a.action,
    },
    {
      key: "target", header: "Target", mobileFullWidth: true,
      cell: (a) => <span className="text-xs text-muted-foreground">{a.target}</span>,
      rawValue: (a) => a.target,
    },
    {
      key: "ip", header: "IP", hideOnMobile: true,
      cell: (a) => <span className="font-mono text-xs text-muted-foreground">{a.ip}</span>,
      rawValue: (a) => a.ip,
    },
    {
      key: "at", header: "When",
      cell: (a) => <span className="text-xs text-muted-foreground tabular">{fmtRelativeTime(a.at)}</span>,
      rawValue: (a) => a.at,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Multi-user management and audit log. Every trigger that spends API quota is recorded with the operator who clicked. Admins can manage roles; operators can trigger; viewers can read only."
        actions={
          <Button onClick={() => setAddOpen(true)} className="gap-1.5">
            <UserPlus className="size-3.5" /> Invite user
          </Button>
        }
      />

      <Panel
        title="Users"
        subtitle={`${users.length} users · ${users.filter((u) => u.role === "admin").length} admin · ${users.filter((u) => u.twoFactor).length} with 2FA`}
        actions={<FilterPills pills={ROLE_PILLS} value={roleFilter} onChange={setRoleFilter} ariaLabel="Role filter" />}
      >
        <DataTable columns={userCols} rows={visibleUsers} filename="users" />
      </Panel>

      <Panel
        title="Audit log"
        subtitle={`${audit.length} entries · newest first · kept for 90 days`}
        count={audit.length}
      >
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <DataTable columns={auditCols} rows={audit} filename="audit-log" />
        </div>
      </Panel>

      <Panel title="Permissions matrix" subtitle="What each role can do">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3">Action</th>
                <th className="text-center py-2 px-3">Admin</th>
                <th className="text-center py-2 px-3">Operator</th>
                <th className="text-center py-2 px-3">Viewer</th>
              </tr>
            </thead>
            <tbody>
              {[
                { action: "View dashboard", admin: true, op: true, view: true },
                { action: "Trigger news backfill", admin: true, op: true, view: false },
                { action: "Trigger price backfill", admin: true, op: true, view: false },
                { action: "Trigger backtest run", admin: true, op: true, view: false },
                { action: "Invite / remove users", admin: true, op: false, view: false },
                { action: "Change role", admin: true, op: false, view: false },
                { action: "View audit log", admin: true, op: false, view: false },
                { action: "Export tables (CSV / JSON)", admin: true, op: true, view: true },
              ].map((row) => (
                <tr key={row.action} className="border-b border-border/60">
                  <td className="py-2 px-3">{row.action}</td>
                  <td className="text-center py-2 px-3"><PermBadge ok={row.admin} /></td>
                  <td className="text-center py-2 px-3"><PermBadge ok={row.op} /></td>
                  <td className="text-center py-2 px-3"><PermBadge ok={row.view} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Add user dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>
              The invited user will receive an email with a one-time setup link. Their first action is recorded in the audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="new-name" className="text-xs">Full name</Label>
              <Input id="new-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Alex Nguyen" className="h-9 mt-1" />
            </div>
            <div>
              <Label htmlFor="new-username" className="text-xs">Username</Label>
              <Input id="new-username" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="alex" className="h-9 mt-1 font-mono lowercase text-xs" />
            </div>
            <div>
              <Label className="text-xs">Role</Label>
              <div className="mt-1.5">
                <FilterPills
                  pills={[
                    { value: "admin", label: "Admin" },
                    { value: "operator", label: "Operator" },
                    { value: "viewer", label: "Viewer" },
                  ]}
                  value={newRole}
                  onChange={(v) => setNewRole(v as UserRole)}
                  ariaLabel="Role"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={addUser} className="gap-1.5">
              <UserPlus className="size-3.5" /> Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PermBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center justify-center size-5 rounded-full bg-emerald-500/10 text-emerald-500">
      <ShieldCheck className="size-3" />
    </span>
  ) : (
    <span className="inline-flex items-center justify-center size-5 rounded-full bg-muted text-muted-foreground">
      <Clock className="size-3 opacity-40" />
    </span>
  );
}
