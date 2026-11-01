import type { ActivityView } from "@weaver/core/dashboard/schema";

export type ActivityState = {
  view: ActivityView;
  projectId: string | undefined;
  cursors: (string | null)[];
  page: number;
};
export type ActivityAction =
  | { type: "filter"; view: ActivityView; projectId?: string }
  | { type: "next"; cursor: string }
  | { type: "previous" }
  | { type: "refresh" };

export const initialActivityState = (projectId?: string): ActivityState => ({
  view: "all",
  projectId,
  cursors: [null],
  page: 0,
});

export function activityReducer(
  state: ActivityState,
  action: ActivityAction,
): ActivityState {
  if (action.type === "filter")
    return {
      view: action.view,
      projectId: action.projectId,
      cursors: [null],
      page: 0,
    };
  if (action.type === "refresh") return { ...state, cursors: [null], page: 0 };
  if (action.type === "previous")
    return { ...state, page: Math.max(0, state.page - 1) };
  const cursors = state.cursors.slice(0, state.page + 1);
  cursors.push(action.cursor);
  return { ...state, cursors, page: state.page + 1 };
}
