import { CreateInventoryLevelInput, ExecArgs } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
  uploadFilesWorkflow,
} from "@medusajs/medusa/core-flows";
import fs from "fs/promises";
import path from "path";

export default async function seedDemoData({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const fulfillment = container.resolve(Modules.FULFILLMENT);
  const salesChannelService = container.resolve(Modules.SALES_CHANNEL);
  const storeService = container.resolve(Modules.STORE);

  const assetsDir = path.join(process.cwd(), "assets");
  const uploadAsset = async (relativePath: string) => {
    const filePath = path.join(assetsDir, relativePath);
    const [{ url }] = (
      await uploadFilesWorkflow(container).run({
        input: {
          files: [
            {
              filename: path.basename(filePath),
              mimeType: "image/png",
              content: (await fs.readFile(filePath)).toString("base64"),
              access: "public",
            },
          ],
        },
      })
    ).result;
    return url;
  };

  const restOfEurope = [
    "at",
    "be",
    "bg",
    "hr",
    "cy",
    "cz",
    "dk",
    "ee",
    "fi",
    "fr",
    "de",
    "gr",
    "hu",
    "ie",
    "it",
    "lv",
    "lu",
    "mt",
    "nl",
    "pl",
    "pt",
    "ro",
    "sk",
    "si",
    "es",
    "se",
  ];
  const shippingCountries = ["lt", ...restOfEurope];

  logger.info("Store + Sales Channel");
  const [store] = await storeService.listStores();
  if (!store) throw new Error("No store exists");

  const [salesChannel] = await salesChannelService.listSalesChannels({});
  if (!salesChannel) throw new Error("No sales channel exists");

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        supported_currencies: [
          { currency_code: "eur", is_default: true },
          { currency_code: "usd" },
        ],
        default_sales_channel_id: salesChannel.id,
      },
    },
  });

  logger.info("Regions");
  const { result: regions } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "Lithuania",
          currency_code: "eur",
          countries: ["lt"],
          metadata: { shortName: "€ LT" },
        },
        {
          name: "Rest of Europe",
          currency_code: "eur",
          countries: restOfEurope,
          payment_providers: ["pp_system_default"],
          metadata: { shortName: "€ EU" },
        },
      ],
    },
  });

  const ltRegion = regions.find((r) => r.name === "Lithuania")!;
  const euRegion = regions.find((r) => r.name === "Rest of Europe")!;

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: { default_region_id: ltRegion.id },
    },
  });

  logger.info("Stock location");
  const { result: locations } = await createStockLocationsWorkflow(
    container,
  ).run({
    input: {
      locations: [
        {
          name: "h2bc hq",
          address: {
            address_1: "M. Vyganto",
            address_2: "12",
            city: "Vilnius",
            postal_code: "01234",
            country_code: "LT",
          },
        },
      ],
    },
  });

  const stockLocation = locations[0];

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: { default_location_id: stockLocation.id },
    },
  });

  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  });

  logger.info("Shipping");
  const shippingProfile =
    (await fulfillment.listShippingProfiles({ type: "default" }))[0] ??
    (
      await createShippingProfilesWorkflow(container).run({
        input: {
          data: [{ name: "Default Shipping Profile", type: "default" }],
        },
      })
    ).result[0];

  const [fulfillmentSet] = await fulfillment.createFulfillmentSets([
    {
      name: "h2bc shipping",
      type: "shipping",
      service_zones: [
        {
          name: "Europe",
          geo_zones: shippingCountries.map((c) => ({
            type: "country" as const,
            country_code: c,
          })),
        },
      ],
    },
  ]);

  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  });

  await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Standard Shipping",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: shippingProfile.id,
        type: { label: "Standard", description: "2–3 days", code: "standard" },
        prices: [
          { currency_code: "eur", amount: 10 },
          { currency_code: "usd", amount: 10 },
          { region_id: euRegion.id, amount: 10 },
          { region_id: ltRegion.id, amount: 10 },
        ],
        rules: [
          { attribute: "enabled_in_store", operator: "eq", value: "true" },
          { attribute: "is_return", operator: "eq", value: "false" },
        ],
      },
    ],
  });

  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: stockLocation.id, add: [salesChannel.id] },
  });

  logger.info("Publishable API key");
  const { result: apiKeys } = await createApiKeysWorkflow(container).run({
    input: {
      api_keys: [{ title: "Webshop", type: "publishable", created_by: "" }],
    },
  });

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: apiKeys[0].id, add: [salesChannel.id] },
  });

  logger.info("Categories");
  const { result: categories } = await createProductCategoriesWorkflow(
    container,
  ).run({
    input: {
      product_categories: [
        {
          name: "PRINT ON DEMAND",
          handle: "print-on-demand",
          is_active: true,
          rank: 0,
        },
        { name: "BEANIES", handle: "bean", is_active: true, rank: 1 },
        { name: "BELTS", handle: "belts", is_active: true, rank: 2 },
        { name: "JEWELLERY", handle: "jewellery", is_active: true, rank: 3 },
      ],
    },
  });

  const pod = categories.find((c) => c.handle === "print-on-demand")!.id;
  const beanies = categories.find((c) => c.handle === "bean")!.id;
  const belts = categories.find((c) => c.handle === "belts")!.id;

  logger.info("Upload assets");
  const assetUrls = {
    meduzaTeeFront: await uploadAsset(
      "meduza tee/meduza-tee-front.png",
    ),
    meduzaTeeBack: await uploadAsset("meduza tee/meduza-tee-back.png"),
    meduzaHoodFront: await uploadAsset(
      "meduza hoodie/meduza-hood-front.png",
    ),
    meduzaHoodBack: await uploadAsset(
      "meduza hoodie/meduza-hood-back.png",
    ),
    trainerShortsFront: await uploadAsset(
      "training shorts/trainer-shorts-front-blank.png",
    ),
    trainerShortsBack: await uploadAsset(
      "training shorts/trainer-shorts-back-blank.png",
    ),
    h2bcBeanieFront: await uploadAsset(
      "h2bc beanie/h2bc-beanie-front.png",
    ),
    studdedBeltFront: await uploadAsset(
      "studded belt/studded-belt-front.png",
    ),
  };

  logger.info("Products");
  const products = [
    {
      title: "STUDDED PU$$Y BELT",
      handle: "cat-studded-belt",
      category_ids: [belts],
      shipping_profile_id: shippingProfile.id,
      status: ProductStatus.PUBLISHED,
      images: [
        { url: assetUrls.studdedBeltFront },
      ],
      options: [{ title: "Size", values: ["ONESIZE"] }],
      variants: [
        {
          title: "ONESIZE",
          sku: "cat-studded-belt",
          options: { Size: "ONESIZE" },
          prices: [
            { amount: 80, currency_code: "eur" },
            { amount: 95, currency_code: "usd" },
          ],
        },
      ],
      sales_channels: [{ id: salesChannel.id }],
    },
    {
      title: "TRAINER SHORTS",
      handle: "trainer-shorts",
      category_ids: [pod],
      shipping_profile_id: shippingProfile.id,
      status: ProductStatus.PUBLISHED,
      images: [
        { url: assetUrls.trainerShortsFront },
        { url: assetUrls.trainerShortsBack },
      ],
      options: [{ title: "Size", values: ["S", "M", "L", "XL"] }],
      variants: ["S", "M", "L", "XL"].map((s, index) => ({
        title: s,
        sku: `trainer-shorts-${s.toLowerCase()}`,
        options: { Size: s },
        variant_rank: index,
        manage_inventory: false,
        prices: [
          { amount: 45, currency_code: "eur" },
          { amount: 55, currency_code: "usd" },
        ],
      })),
      sales_channels: [{ id: salesChannel.id }],
    },
    {
      title: "H2BC BEANIE",
      handle: "h2bc-beanie",
      category_ids: [beanies],
      shipping_profile_id: shippingProfile.id,
      status: ProductStatus.PUBLISHED,
      images: [
        { url: assetUrls.h2bcBeanieFront },
      ],
      options: [{ title: "Size", values: ["ONESIZE"] }],
      variants: [
        {
          title: "ONESIZE",
          sku: "h2bc-beanie",
          options: { Size: "ONESIZE" },
          prices: [
            { amount: 25, currency_code: "eur" },
            { amount: 30, currency_code: "usd" },
          ],
        },
      ],
      sales_channels: [{ id: salesChannel.id }],
    },
    {
      title: "MEDUZA HOOD",
      handle: "meduza-hood",
      category_ids: [pod],
      shipping_profile_id: shippingProfile.id,
      status: ProductStatus.PUBLISHED,
      images: [
        { url: assetUrls.meduzaHoodFront },
        { url: assetUrls.meduzaHoodBack },
      ],
      options: [{ title: "Size", values: ["S", "M", "L", "XL"] }],
      variants: ["S", "M", "L", "XL"].map((s, index) => ({
        title: s,
        sku: `meduza-hood-${s.toLowerCase()}`,
        options: { Size: s },
        variant_rank: index,
        manage_inventory: false,
        prices: [
          { amount: 60, currency_code: "eur" },
          { amount: 70, currency_code: "usd" },
        ],
      })),
      sales_channels: [{ id: salesChannel.id }],
    },
    {
      title: "MEDUZA TEE",
      handle: "meduza-tee",
      category_ids: [pod],
      shipping_profile_id: shippingProfile.id,
      status: ProductStatus.PUBLISHED,
      images: [
        { url: assetUrls.meduzaTeeFront },
        { url: assetUrls.meduzaTeeBack },
      ],
      options: [{ title: "Size", values: ["S", "M", "L", "XL"] }],
      variants: ["S", "M", "L", "XL"].map((s, index) => ({
        title: s,
        sku: `meduza-tee-${s.toLowerCase()}`,
        options: { Size: s },
        variant_rank: index,
        manage_inventory: false,
        prices: [
          { amount: 25, currency_code: "eur" },
          { amount: 30, currency_code: "usd" },
        ],
      })),
      sales_channels: [{ id: salesChannel.id }],
    },
  ];

  for (const product of products) {
    await createProductsWorkflow(container).run({
      input: { products: [product] },
    });
  }

  logger.info("Inventory");
  const inventoryBySku: Record<string, number> = {
    "h2bc-beanie": 0,
    "cat-studded-belt": 0,
  };

  const { data: inventoryItems } = await query.graph({
    entity: "inventory_item",
    fields: ["id", "sku"],
  });

  const inventoryLevels: CreateInventoryLevelInput[] = inventoryItems
    .filter((i: any) => inventoryBySku[i.sku] !== undefined)
    .map((i: any) => ({
      location_id: stockLocation.id,
      inventory_item_id: i.id,
      stocked_quantity: inventoryBySku[i.sku],
    }));

  await createInventoryLevelsWorkflow(container).run({
    input: { inventory_levels: inventoryLevels },
  });

  logger.info("Seed finished");
}
