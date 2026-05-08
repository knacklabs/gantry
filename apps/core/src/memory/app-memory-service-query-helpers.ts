type ThreadFilterSqlOps = {
  eq: (left: any, right: any) => any;
  isNull: (value: any) => any;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function createSqlThreadIdentityFilter(sqlOps: ThreadFilterSqlOps) {
  return (i: { threadId: any }, threadId: string | undefined): any =>
    threadId
      ? sqlOps.eq(i.threadId as any, threadId)
      : sqlOps.isNull(i.threadId as any);
}
