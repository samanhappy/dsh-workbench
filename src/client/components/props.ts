// dsh-workbench — framework-injected props shared by the panels.
//
// The slot system injects these props into every registered component: the
// global selector seats (useSessions / useWorkspaces) are stable per mount.

/** Stable identity for useWorkspaces selectors while the registry is absent. */
export const EMPTY_ITEMS: never[] = []

export interface FrameworkProps {
  useSessions?: (selector: (snap: any) => any) => any
  useWorkspaces?: (selector: (snap: any) => any) => any
  [key: string]: unknown
}
