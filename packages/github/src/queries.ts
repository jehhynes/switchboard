/** The configured status field's type; gh exits 1 when the project has no field of that name (mechanics M17). */
export const FIELD_QUERY = `
query($owner:String!, $number:Int!, $status:String!){
  repositoryOwner(login:$owner){ ... on ProjectV2Owner{ projectV2(number:$number){ field(name:$status){ __typename } } } }
}`;

/** Repeated `assignee:` qualifiers are ORed in issue search (GC issues.ts, verified live). `blockedBy` lists closed blockers too (mechanics M56). */
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
      blockedBy(first:50){ nodes{ number title url state repository{ nameWithOwner } } }
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
query($owner:String!, $name:String!, $number:Int!, $status:String!){
  repository(owner:$owner, name:$name){
    issue(number:$number){
      number title url body
      projectItems(first:20){ nodes{
        project{ number owner{ ... on Organization{ login } ... on User{ login } } }
        fieldValueByName(name:$status){ ... on ProjectV2ItemFieldSingleSelectValue{ name updatedAt } }
      }}
      assignees(first:10){ nodes{ login } }
      comments(last:5){ nodes{ body createdAt url author{ __typename login } } }
      timelineItems(last:100, itemTypes:[ASSIGNED_EVENT, UNASSIGNED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){ nodes{
        __typename
        ... on AssignedEvent{ createdAt actor{ __typename login } assignee{ ... on User{ login } ... on Bot{ login } } }
        ... on UnassignedEvent{ createdAt actor{ __typename login } assignee{ ... on User{ login } ... on Bot{ login } } }
        ... on ProjectV2ItemStatusChangedEvent{ createdAt actor{ __typename login } previousStatus status project{ number owner{ ... on Organization{ login } ... on User{ login } } } }
      }}
      closedByPullRequestsReferences(first:5){ nodes{
        number title url state isDraft updatedAt body
        author{ __typename login }
        reviewRequests(first:10){ nodes{ requestedReviewer{ ... on User{ login } ... on Team{ slug } } } }
        comments(last:5){ nodes{ body createdAt url author{ __typename login } } }
        commits(last:1){ nodes{ commit{ committedDate author{ user{ login } } statusCheckRollup{ state } } } }
        reviews(last:20){ nodes{ state submittedAt author{ __typename login } } }
        submittedReviews: reviews(last:100, states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]){ totalCount nodes{ submittedAt author{ login } } }
        allComments: comments(last:100){ totalCount nodes{ createdAt author{ login } } }
        reviewThreads(last:5){ nodes{ isResolved comments(first:3){ nodes{ body createdAt url author{ __typename login } } } } }
      }}
    }
  }
}`;

/** A pull request's branch and the issues it closes, to check a reported link (PRD R52). */
export const PULL_REQUEST_QUERY = `
query($owner:String!, $name:String!, $number:Int!){
  repository(owner:$owner, name:$name){
    pullRequest(number:$number){
      headRefName
      closingIssuesReferences(first:50){ pageInfo{ hasNextPage } nodes{ number repository{ nameWithOwner } } }
    }
  }
}`;

/** One issue's identity and state, for a ticket report (PRD R83). gh exits 1 when the number is not an issue of the repository. */
export const ISSUE_QUERY = `
query($owner:String!, $name:String!, $number:Int!){
  repository(owner:$owner, name:$name){ issue(number:$number){ number title url state } }
}`;
