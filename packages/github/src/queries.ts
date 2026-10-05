/** Repeated `assignee:` qualifiers are ORed in issue search (GC issues.ts, verified live). */
export const ISSUES_QUERY = `
query($q:String!, $status:String!, $after:String){
  search(query:$q, type:ISSUE, first:100, after:$after){
    pageInfo{ hasNextPage endCursor }
    nodes{ ... on Issue{
      number title url
      projectItems(first:20){ nodes{
        project{ number owner{ ... on Organization{ login } ... on User{ login } } }
        fieldValueByName(name:$status){ ... on ProjectV2ItemFieldSingleSelectValue{ name updatedAt } }
      }}
      assignees(first:10){ nodes{ login } }
      timelineItems(last:100, itemTypes:[ASSIGNED_EVENT, UNASSIGNED_EVENT]){ nodes{
        __typename
        ... on AssignedEvent{ createdAt assignee{ ... on User{ login } ... on Bot{ login } } }
        ... on UnassignedEvent{ createdAt assignee{ ... on User{ login } ... on Bot{ login } } }
      }}
    }}
  }
}`;

/** Ground Control's card context (GC CARD_CONTEXT_QUERY), with the closing pull requests read in the same request. */
export const CONTEXT_QUERY = `
query($owner:String!, $name:String!, $number:Int!){
  repository(owner:$owner, name:$name){
    issue(number:$number){
      number title url body
      assignees(first:10){ nodes{ login } }
      comments(last:5){ nodes{ body createdAt author{ login } } }
      timelineItems(last:100, itemTypes:[ASSIGNED_EVENT, UNASSIGNED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){ nodes{
        __typename
        ... on AssignedEvent{ createdAt actor{ login } assignee{ ... on User{ login } ... on Bot{ login } } }
        ... on UnassignedEvent{ createdAt actor{ login } assignee{ ... on User{ login } ... on Bot{ login } } }
        ... on ProjectV2ItemStatusChangedEvent{ createdAt actor{ login } previousStatus status project{ number owner{ ... on Organization{ login } ... on User{ login } } } }
      }}
      closedByPullRequestsReferences(first:5){ nodes{
        number title url state isDraft updatedAt body
        author{ login }
        reviewRequests(first:10){ nodes{ requestedReviewer{ ... on User{ login } ... on Team{ slug } } } }
        comments(last:5){ nodes{ body createdAt author{ login } } }
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
        reviews(last:20){ nodes{ state submittedAt author{ login } } }
        reviewThreads(last:5){ nodes{ isResolved comments(first:3){ nodes{ body createdAt author{ login } } } } }
      }}
    }
  }
}`;
