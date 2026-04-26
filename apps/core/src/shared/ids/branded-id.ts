declare const brand: unique symbol;

export type BrandedId<Name extends string> = string & {
  readonly [brand]: Name;
};

export type ExternalRef<Kind extends string> = {
  readonly kind: Kind;
  readonly value: string;
};
