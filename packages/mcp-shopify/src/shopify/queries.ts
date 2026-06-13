export const CUSTOMER_FIELDS = `
  id
  firstName
  lastName
  email
  phone
`;

export const MONEY_FIELDS = `amount currencyCode`;

export const ORDER_FIELDS = `
  id
  name
  displayFinancialStatus
  displayFulfillmentStatus
  createdAt
  processedAt
  cancelledAt
  totalPriceSet { shopMoney { ${MONEY_FIELDS} } }
  discountCodes
  customer { ${CUSTOMER_FIELDS} }
  shippingAddress { city province country zip }
  lineItems(first: 50) {
    edges { node { title quantity sku } }
  }
  fulfillments(first: 10) {
    status
    trackingInfo { url company number }
    estimatedDeliveryAt
  }
`;

export const FIND_CUSTOMER_BY_PHONE = `
query FindCustomerByPhone($query: String!) {
  customers(first: 5, query: $query) {
    edges { node { ${CUSTOMER_FIELDS} } }
  }
}`;

export const FIND_CUSTOMER_BY_EMAIL = `
query FindCustomerByEmail($query: String!) {
  customers(first: 5, query: $query) {
    edges { node { ${CUSTOMER_FIELDS} } }
  }
}`;

export const FIND_ORDER_BY_NAME = `
query FindOrderByName($query: String!) {
  orders(first: 5, query: $query) {
    edges { node { ${ORDER_FIELDS} } }
  }
}`;

export const LIST_ORDERS_FOR_CUSTOMER = `
query ListOrdersForCustomer($query: String!, $first: Int!, $reverse: Boolean = true) {
  orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: $reverse) {
    edges { node { ${ORDER_FIELDS} } }
  }
}`;

export const SEARCH_PRODUCTS = `
query SearchProducts($query: String!, $first: Int!) {
  products(first: $first, query: $query) {
    edges {
      node {
        id
        handle
        title
        description
        onlineStoreUrl
        tags
        totalInventory
        priceRangeV2 {
          minVariantPrice { ${MONEY_FIELDS} }
          maxVariantPrice { ${MONEY_FIELDS} }
        }
        featuredImage { url altText }
        images(first: 4) { edges { node { url altText } } }
      }
    }
  }
}`;

export const GET_PRODUCT_BY_HANDLE = `
query GetProductByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    handle
    title
    description
    onlineStoreUrl
    tags
    totalInventory
    priceRangeV2 {
      minVariantPrice { ${MONEY_FIELDS} }
      maxVariantPrice { ${MONEY_FIELDS} }
    }
    featuredImage { url altText }
    images(first: 4) { edges { node { url altText } } }
  }
}`;

export const GET_PRODUCT_BY_ID = `
query GetProductById($id: ID!) {
  product(id: $id) {
    id
    handle
    title
    description
    onlineStoreUrl
    tags
    totalInventory
    priceRangeV2 {
      minVariantPrice { ${MONEY_FIELDS} }
      maxVariantPrice { ${MONEY_FIELDS} }
    }
    featuredImage { url altText }
    images(first: 4) { edges { node { url altText } } }
  }
}`;

export const CHECK_INVENTORY_BY_VARIANT = `
query CheckInventoryByVariant($id: ID!) {
  productVariant(id: $id) {
    id
    inventoryQuantity
    availableForSale
    product { id handle title }
  }
}`;

export const CHECK_INVENTORY_BY_HANDLE = `
query CheckInventoryByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    totalInventory
    variants(first: 25) {
      edges { node { id inventoryQuantity availableForSale } }
    }
  }
}`;

export const VALIDATE_DISCOUNT_CODE = `
query ValidateDiscountCode($query: String!) {
  codeDiscountNodes(first: 5, query: $query) {
    edges {
      node {
        id
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            title
            status
            startsAt
            endsAt
            minimumRequirement {
              ... on DiscountMinimumSubtotal {
                greaterThanOrEqualToSubtotal { ${MONEY_FIELDS} }
              }
            }
            customerGets { items { __typename } }
          }
          ... on DiscountCodeFreeShipping {
            title
            status
            startsAt
            endsAt
            minimumRequirement {
              ... on DiscountMinimumSubtotal {
                greaterThanOrEqualToSubtotal { ${MONEY_FIELDS} }
              }
            }
          }
          ... on DiscountCodeBxgy {
            title
            status
            startsAt
            endsAt
          }
          ... on DiscountCodeApp {
            title
            status
            startsAt
            endsAt
          }
        }
      }
    }
  }
}`;
