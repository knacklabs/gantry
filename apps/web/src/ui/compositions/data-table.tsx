import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
  useReactTable,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

import { IconButton } from '../primitives/icon-button';

type DataTableProps<TData> = {
  columns: ColumnDef<TData>[];
  data: TData[];
  emptyMessage: string;
  page: number;
  pageSize?: number;
  sort?: string;
  descending?: boolean;
  onPageChange: (page: number) => void;
  onSortChange: (column: string, descending: boolean) => void;
};

export function DataTable<TData>({
  columns,
  data,
  emptyMessage,
  page,
  pageSize = 6,
  sort,
  descending = false,
  onPageChange,
  onSortChange,
}: DataTableProps<TData>) {
  const sorting: SortingState = sort ? [{ id: sort, desc: descending }] : [];
  const pageCount = Math.max(1, Math.ceil(data.length / pageSize));
  const pageIndex = Math.min(Math.max(0, page - 1), pageCount - 1);
  const table = useReactTable({
    columns,
    data,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      if (next[0]) onSortChange(next[0].id, next[0].desc);
    },
    state: {
      pagination: { pageIndex, pageSize },
      sorting,
    },
  });

  const visiblePage = pageIndex + 1;

  return (
    <div className="min-w-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] border-collapse text-left text-[13px]">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                className="border-b border-border bg-surface-muted"
                key={headerGroup.id}
              >
                {headerGroup.headers.map((header) => (
                  <th
                    className="h-10 px-4 font-medium text-text-secondary"
                    key={header.id}
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <button
                        className="inline-flex min-h-8 items-center gap-1.5 rounded px-1 hover:text-text"
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        <SortIcon direction={header.column.getIsSorted()} />
                      </button>
                    ) : (
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <tr
                  className="border-b border-border last:border-0 hover:bg-surface-muted"
                  key={row.id}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      className="h-14 px-4 align-middle text-text-secondary"
                      key={cell.id}
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  className="h-28 px-4 text-center text-text-secondary"
                  colSpan={columns.length}
                >
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex min-h-14 items-center justify-between border-t border-border px-4 text-xs text-text-secondary">
        <span>
          Page {visiblePage} of {pageCount} · {data.length} records
        </span>
        <div className="flex gap-1">
          <IconButton
            aria-label="Previous page"
            disabled={visiblePage <= 1}
            title="Previous page"
            onClick={() => onPageChange(visiblePage - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label="Next page"
            disabled={visiblePage >= pageCount}
            title="Next page"
            onClick={() => onPageChange(visiblePage + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function SortIcon({ direction }: { direction: false | 'asc' | 'desc' }) {
  if (direction === 'asc') return <ArrowUp size={14} aria-hidden="true" />;
  if (direction === 'desc') return <ArrowDown size={14} aria-hidden="true" />;
  return (
    <ArrowUpDown className="text-text-muted" size={14} aria-hidden="true" />
  );
}
