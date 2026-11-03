import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AppLoading from "@/app/(app)/loading";
import TasksLoading from "@/app/(app)/tasks/loading";
import CompaniesLoading from "@/app/(app)/companies/loading";
import HoldingLoading from "@/app/(app)/holding/loading";
import PeopleLoading from "@/app/(app)/people/loading";
import AiRolesLoading from "@/app/(app)/ai-roles/loading";
import OrgLoading from "@/app/(app)/org/loading";

describe("Next.js Streaming Loading Skeletons", () => {
  const skeletons = [
    { name: "AppLoading", component: AppLoading },
    { name: "TasksLoading", component: TasksLoading },
    { name: "CompaniesLoading", component: CompaniesLoading },
    { name: "HoldingLoading", component: HoldingLoading },
    { name: "PeopleLoading", component: PeopleLoading },
    { name: "AiRolesLoading", component: AiRolesLoading },
    { name: "OrgLoading", component: OrgLoading },
  ];

  for (const { name, component } of skeletons) {
    it(`${name} renders without crashing and contains pulse animations`, () => {
      const html = renderToStaticMarkup(createElement(component));
      expect(html).toContain("animate-pulse");
      expect(html).toContain("aria-busy=\"true\"");
    });
  }
});
