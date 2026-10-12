export interface UserRow {
  id: string;
  authentik_sub: string;
  email: string | null;
  name: string;
  role: string;
  jellyfin_user_id: string;
  jellyfin_username: string;
  jellyfin_pw_enc: string;
  seerr_user_id: number | null;
  disabled: boolean;
  created_at: Date;
}

/** What JellyfinService needs to act as a Jellyfin user: an account's own row or a (non-owner) profile's credentials. */
export type JfUser = Pick<UserRow, 'id' | 'jellyfin_user_id' | 'jellyfin_username' | 'jellyfin_pw_enc'>;

export interface ProfileRow {
  id: string;
  user_id: string;
  name: string;
  avatar: string;
  is_owner: boolean;
  pin_hash: string | null;
  jellyfin_user_id: string | null;
  jellyfin_username: string | null;
  jellyfin_pw_enc: string | null;
  created_at: Date;
}
