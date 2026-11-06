/**
 * GitHub ticket keys (PRD R44). An issue in the source's home repository keeps its bare number, such as `18941`, so stored tickets, History,
 * windows and `{{ticket.sourceKey}}` templates keep their meaning; an issue in another repository is `owner/name#63`, in lowercase.
 */

export interface IssueId {
  /** `owner/name` in lowercase. */
  repo: string;
  number: number;
}

const QUALIFIED = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/** The repository and number of a key; a bare number is the home repository's. Null for a key no GitHub source writes. */
export function parseKey(home: string, key: string): IssueId | null {
  if (/^\d+$/.test(key)) {
    return { repo: home, number: Number(key) };
  }

  const match = QUALIFIED.exec(key);

  return match === null ? null : { repo: match[1]!.toLowerCase(), number: Number(match[2]) };
}

export function keyOf(home: string, repo: string, number: number): string {
  return repo.toLowerCase() === home ? String(number) : `${repo.toLowerCase()}#${number}`;
}

/** The reference people use: `#18941` in the home repository, `owner/name#63` elsewhere. */
export function refOf(home: string, repo: string, number: number): string {
  return repo.toLowerCase() === home ? `#${number}` : `${repo.toLowerCase()}#${number}`;
}

/** `owner` and `name` for a GraphQL `repository(owner:, name:)` read. */
export function ownerName(repo: string): { owner: string; name: string } {
  const [owner = '', name = ''] = repo.split('/');

  return { owner, name };
}
