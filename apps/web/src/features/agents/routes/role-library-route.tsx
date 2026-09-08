import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { Button } from '../../../ui/primitives/button';
import { roleDirectoryQuery } from '../agents-queries';
import { RolesLibrary } from '../components/roles-library';

export function RoleLibraryRoute() {
  const search = useSearch({ from: '/roles' });
  const navigate = useNavigate({ from: '/roles' });
  const builtIns = useQuery(
    roleDirectoryQuery({ page: 1, pageSize: 25, search: '', kind: 'built-in' }),
  );
  const customRoles = useQuery(
    roleDirectoryQuery({
      page: search.page,
      pageSize: search.pageSize,
      search: search.q,
      kind: 'custom',
    }),
  );

  return (
    <div className="mx-auto w-full max-w-[1240px]">
      <Link
        search={{
          tab: 'agents',
          kind: 'all',
          q: '',
          status: 'all',
          page: 1,
          pageSize: 25,
          role: 'all',
          sort: 'name',
          desc: false,
        }}
        to="/agents"
      >
        <Button variant="outline">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to directory
        </Button>
      </Link>
      <div className="mt-5">
        <PageHeader
          eyebrow="Administration"
          title="Role library"
          description="Reusable instruction templates for AI employees."
        />
      </div>
      <div className="mt-5">
        <RolesLibrary
          builtIns={builtIns.data}
          data={customRoles.data}
          error={builtIns.isError || customRoles.isError}
          loading={builtIns.isLoading || customRoles.isLoading}
          search={search.q}
          onSearchChange={(q) =>
            void navigate({ search: { ...search, q, page: 1 } })
          }
          onPageChange={(page) =>
            void navigate({ search: { ...search, page } })
          }
          onPageSizeChange={(pageSize) =>
            void navigate({
              search: {
                ...search,
                page: 1,
                pageSize: pageSize as typeof search.pageSize,
              },
            })
          }
          onRetry={() => {
            void builtIns.refetch();
            void customRoles.refetch();
          }}
        />
      </div>
    </div>
  );
}
