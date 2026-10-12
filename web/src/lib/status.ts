export type Status = 'none' | 'planned' | 'watching' | 'watched' | 'dropped';

/** Watch status after "Merkliste" was toggled for the same item (adding plans it, removing un-plans it). */
export function statusAfterListChange(status: Status, inList: boolean): Status {
  if (inList) return status === 'none' || status === 'dropped' ? 'planned' : status;
  return status === 'planned' ? 'none' : status;
}
