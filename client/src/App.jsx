import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ||
  "";

const SEK = new Intl.NumberFormat("sv-SE", {
  style: "currency",
  currency: "SEK",
  maximumFractionDigits: 0,
});

const PERCENT = new Intl.NumberFormat("sv-SE", {
  style: "percent",
  maximumFractionDigits: 1,
});

const NUMBER = new Intl.NumberFormat("sv-SE", {
  maximumFractionDigits: 1,
});

const TAX_TABLES = [
  { id: "29", label: "Tabell 29 (~29% skatt)", rate: 0.29 },
  { id: "30", label: "Tabell 30 (~30% skatt)", rate: 0.3 },
  { id: "31", label: "Tabell 31 (~31% skatt)", rate: 0.31 },
  { id: "32", label: "Tabell 32 (~32% skatt)", rate: 0.32 },
  { id: "33", label: "Tabell 33 (~33% skatt)", rate: 0.33 },
  { id: "34", label: "Tabell 34 (~34% skatt)", rate: 0.34 },
];

const TAX_TABLE_MAP = TAX_TABLES.reduce((acc, table) => {
  acc[table.id] = table;
  return acc;
}, {});

const formatCurrencyPreview = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "";
  }
  return SEK.format(parsed);
};

const formatMagnitudeLabel = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "";
  }
  if (parsed >= 1_000_000) {
    return `≈ ${NUMBER.format(parsed / 1_000_000)} miljoner kr`;
  }
  if (parsed >= 1_000) {
    return `≈ ${NUMBER.format(parsed / 1_000)} tusen kr`;
  }
  return `≈ ${SEK.format(parsed)}`;
};

const formatAmountPreview = (value) => {
  const currency = formatCurrencyPreview(value);
  const magnitude = formatMagnitudeLabel(value);
  if (!currency && !magnitude) {
    return "";
  }
  if (currency && magnitude) {
    return `${currency} · ${magnitude}`;
  }
  return currency || magnitude;
};

const DEFAULT_CATEGORIES = [
  { id: "drift", name: "Drift & hushåll" },
  { id: "mat", name: "Mat & dagligvaror" },
  { id: "underhall", name: "Underhållning" },
];

const initialExtraCost = {
  name: "",
  amount: "",
  frequency: "monthly",
  shareWithEx: false,
  categoryId: DEFAULT_CATEGORIES[0].id,
};
const initialPropertyInfo = { name: "", value: "" };
const initialSavingsItem = { name: "", amount: "", frequency: "monthly" };
const STORAGE_KEY = "budgetapp:savedLoanData";

const createCostId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const createCategoryId = () => createCostId();

const createPersonId = () => createCostId();

const createIncomePerson = (overrides = {}) => ({
  id: overrides.id ?? createPersonId(),
  name: overrides.name ?? "",
  incomeGross: overrides.incomeGross ?? "",
  taxTable: overrides.taxTable ?? "30",
  carBenefit: overrides.carBenefit ?? "",
});

const normalizeIncomePersons = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return [createIncomePerson({ name: "Person 1" })];
  }
  return items.map((person, index) =>
    createIncomePerson({
      id: person.id ?? createPersonId(),
      name: person.name ?? `Person ${index + 1}`,
      incomeGross: person.incomeGross ?? person.income ?? "",
      taxTable: person.taxTable ?? person.table ?? "30",
      carBenefit: person.carBenefit ?? "",
    }),
  );
};

const createLoanId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const normalizeSavedLoans = (items) => {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item, index) => ({
      id: item.id ?? createLoanId(),
      name: item.name ?? `Lån ${index + 1}`,
      amount: item.amount != null ? String(item.amount) : "",
      annualInterestRate:
        item.annualInterestRate != null ? String(item.annualInterestRate) : "",
      amortizationPercent:
        item.amortizationPercent != null ? String(item.amortizationPercent) : "2",
      rateType: item.rateType === "fixed" ? "fixed" : "variable",
      fixedTermYears:
        item.fixedTermYears != null
          ? String(item.fixedTermYears)
          : item.rateType === "fixed"
            ? "3"
            : "",
    }))
    .slice(0, MAX_LOANS);
};

const createLoanRow = (index = 0) => ({
  id: createLoanId(),
  name: `Lån ${index + 1}`,
  amount: "",
  annualInterestRate: "",
  amortizationPercent: "2",
  rateType: "variable",
  fixedTermYears: "3",
});

const createInitialLoans = () =>
  Array.from({ length: MAX_LOANS }, (_, index) => createLoanRow(index));

const formatCostFrequency = (value) => {
  if (value === "yearly") {
    return "yearly";
  }
  if (value === "quarterly") {
    return "quarterly";
  }
  if (value === "term" || value === "semester") {
    return "term";
  }
  if (value === "season") {
    return "season";
  }
  return "monthly";
};

const normalizeSavedCosts = (items) => {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => ({
      id: item.id ?? createCostId(),
      name: item.name ?? "",
      amount: Number(item.amount) || 0,
      frequency: formatCostFrequency(item.frequency),
      shareWithEx: Boolean(item.shareWithEx),
    }))
    .filter((item) => item.name && item.amount > 0);
};

const monthlyCostValue = (item) =>
  item.frequency === "yearly"
    ? item.amount / 12
    : item.frequency === "quarterly"
      ? item.amount / 3
      : item.frequency === "term"
        ? item.amount / 6
        : item.frequency === "season"
          ? item.amount / 4
          : item.amount;

const effectiveMonthlyCost = (item) => {
  const base = monthlyCostValue(item);
  return item.shareWithEx ? base / 2 : base;
};

const calculateElectricityMonthlyCost = ({ consumption, price }) => {
  const annualKwh = Number(consumption);
  const kwPrice = Number(price);
  if (
    !Number.isFinite(annualKwh) ||
    annualKwh <= 0 ||
    !Number.isFinite(kwPrice) ||
    kwPrice < 0
  ) {
    return {
      monthlyKwh: 0,
      monthlyCost: 0,
      annualKwh: 0,
    };
  }
  const monthlyKwh = annualKwh / 12;
  const monthlyCost = monthlyKwh * kwPrice;
  return { annualKwh, monthlyKwh, monthlyCost };
};

const calculateInterestDeductionMonthly = (monthlyInterest) => {
  if (!Number.isFinite(monthlyInterest) || monthlyInterest <= 0) {
    return 0;
  }
  const yearlyInterest = monthlyInterest * 12;
  const base = Math.min(yearlyInterest, 100000);
  const excess = Math.max(yearlyInterest - 100000, 0);
  const deductionYearly = base * 0.3 + excess * 0.21;
  return deductionYearly / 12;
};

const clampShare = (value) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  return value > 1 ? 1 : value;
};

const MAX_LOANS = 3;
const SavingsGrowthRate = 0.02;

const canCalculateLoans = (loans) => {
  if (!Array.isArray(loans)) {
    return false;
  }
  return loans.some((loan) => {
    const amount = Number(loan.amount);
    const rate = Number(loan.annualInterestRate);
    const amortization = Number(loan.amortizationPercent);
    return (
      Number.isFinite(amount) &&
      amount > 0 &&
      Number.isFinite(rate) &&
      rate >= 0 &&
      Number.isFinite(amortization) &&
      amortization >= 0
    );
  });
};

function App() {
  const [incomePersons, setIncomePersons] = useState(normalizeIncomePersons([]));
  const [loans, setLoans] = useState(createInitialLoans());
  const [costItems, setCostItems] = useState([]);
  const [newCost, setNewCost] = useState(initialExtraCost);
  const [editingCostId, setEditingCostId] = useState(null);
  const [editingCost, setEditingCost] = useState(initialExtraCost);
  const [costCategories, setCostCategories] = useState(DEFAULT_CATEGORIES);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [propertyInfo, setPropertyInfo] = useState(initialPropertyInfo);
  const [savingsItems, setSavingsItems] = useState([]);
  const [newSavings, setNewSavings] = useState(initialSavingsItem);
  const [electricity, setElectricity] = useState({
    consumption: "",
    price: "",
  });
  const [futureAmortizationPercent, setFutureAmortizationPercent] = useState("0");
  const [scenarioMode, setScenarioMode] = useState("current");
  const [taxAdjustmentEnabled, setTaxAdjustmentEnabled] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [forecastYears, setForecastYears] = useState(10);
  const [savingsForecastYears, setSavingsForecastYears] = useState(5);
  const [rateScenarioDelta, setRateScenarioDelta] = useState(1);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [hasCalculated, setHasCalculated] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const feedbackTimeout = useRef(null);
  const lastSubmittedSnapshot = useRef("");

  const propertyValueNumber = Number(propertyInfo.value);
  const hasPropertyValue = Number.isFinite(propertyValueNumber) && propertyValueNumber > 0;
  const propertyValuePreview = formatAmountPreview(propertyInfo.value);
  const ensureCategoryId = useCallback(
    (candidate) => {
      if (candidate && costCategories.some((category) => category.id === candidate)) {
        return candidate;
      }
      return costCategories[0]?.id ?? DEFAULT_CATEGORIES[0].id;
    },
    [costCategories],
  );
  const formatCurrencyDiff = (value) => {
    const formatted = SEK.format(Math.abs(value));
    if (value > 0) {
      return `+${formatted}`;
    }
    if (value < 0) {
      return `-${formatted}`;
    }
    return formatted;
  };

  const sanitizedLoans = useMemo(
    () =>
      loans.map((loan) => ({
        ...loan,
        amountNumber: Number(loan.amount),
        interestNumber: Number(loan.annualInterestRate),
        amortizationNumber: Number(loan.amortizationPercent),
        rateType: loan.rateType === "fixed" ? "fixed" : "variable",
        fixedTermYearsNumber: Number(loan.fixedTermYears),
      })),
    [loans],
  );

  const activeLoans = useMemo(
    () =>
      sanitizedLoans.filter(
        (loan) =>
          Number.isFinite(loan.amountNumber) &&
          loan.amountNumber > 0 &&
          Number.isFinite(loan.interestNumber) &&
          loan.interestNumber >= 0 &&
          Number.isFinite(loan.amortizationNumber) &&
          loan.amortizationNumber >= 0,
      ),
    [sanitizedLoans],
  );

  const manualLoanTotals = useMemo(() => {
    return activeLoans.reduce(
      (acc, loan) => {
        if (!Number.isFinite(loan.amountNumber) || loan.amountNumber <= 0) {
          return acc;
        }
        acc.totalAmount += loan.amountNumber;
        const rate = Number.isFinite(loan.interestNumber) ? loan.interestNumber : 0;
        const amort = Number.isFinite(loan.amortizationNumber) ? loan.amortizationNumber : 0;
        acc.monthlyInterest += (loan.amountNumber * rate) / 100 / 12;
        acc.monthlyAmortization += (loan.amountNumber * amort) / 100 / 12;
        return acc;
      },
      { totalAmount: 0, monthlyInterest: 0, monthlyAmortization: 0 },
    );
  }, [activeLoans]);

  const manualLoanAverages = useMemo(() => {
    const total = manualLoanTotals.totalAmount;
    if (!Number.isFinite(total) || total <= 0) {
      return null;
    }
    const yearlyInterest = manualLoanTotals.monthlyInterest * 12;
    const yearlyAmortization = manualLoanTotals.monthlyAmortization * 12;
    return {
      total,
      monthlyInterest: manualLoanTotals.monthlyInterest,
      monthlyAmortization: manualLoanTotals.monthlyAmortization,
      effectiveRate: total > 0 ? (yearlyInterest / total) * 100 : 0,
      effectiveAmortPercent: total > 0 ? (yearlyAmortization / total) * 100 : 0,
    };
  }, [manualLoanTotals]);

  const loanTypeBreakdown = useMemo(() => {
    return activeLoans.reduce(
      (acc, loan) => {
        const amount = Number.isFinite(loan.amountNumber) ? loan.amountNumber : 0;
        const rate = Number.isFinite(loan.interestNumber) ? loan.interestNumber : 0;
        const monthlyInterest = amount > 0 ? (amount * rate) / 100 / 12 : 0;
        if (loan.rateType === "fixed") {
          acc.fixed.amount += amount;
          acc.fixed.monthlyInterest += monthlyInterest;
        } else {
          acc.variable.amount += amount;
          acc.variable.monthlyInterest += monthlyInterest;
        }
        return acc;
      },
      {
        variable: { amount: 0, monthlyInterest: 0 },
        fixed: { amount: 0, monthlyInterest: 0 },
      },
    );
  }, [activeLoans]);

  const baseLoanMonthlyTotal =
    result?.totals?.totalMonthlyCost ??
    manualLoanTotals.monthlyInterest + manualLoanTotals.monthlyAmortization;

  const rateScenarioSummary = useMemo(() => {
    const delta = Number(rateScenarioDelta);
    if (
      !Number.isFinite(delta) ||
      activeLoans.length === 0 ||
      loanTypeBreakdown.variable.amount <= 0
    ) {
      return null;
    }
    const baseVariableInterest = loanTypeBreakdown.variable.monthlyInterest;
    const baseFixedInterest =
      manualLoanTotals.monthlyInterest - baseVariableInterest;
    const monthlyAmortizationTotal = manualLoanTotals.monthlyAmortization;

    const computeVariableInterest = (diff) =>
      activeLoans.reduce((sum, loan) => {
        if (loan.rateType === "fixed") {
          return sum;
        }
        if (!Number.isFinite(loan.amountNumber) || loan.amountNumber <= 0) {
          return sum;
        }
        const adjustedRate = Math.max((loan.interestNumber || 0) + diff, 0);
        return sum + (loan.amountNumber * adjustedRate) / 100 / 12;
      }, 0);

    const buildResult = (variableInterestTotal) => {
      const monthlyInterestTotal = baseFixedInterest + variableInterestTotal;
      const total = monthlyInterestTotal + monthlyAmortizationTotal;
      const diff = total - baseLoanMonthlyTotal;
      return { monthlyInterestTotal, total, diff };
    };

    const increase = buildResult(computeVariableInterest(delta));
    const decrease = buildResult(computeVariableInterest(-delta));

    return {
      delta,
      baseTotal: baseLoanMonthlyTotal,
      increase,
      decrease,
      variableAmount: loanTypeBreakdown.variable.amount,
      fixedAmount: loanTypeBreakdown.fixed.amount,
    };
  }, [
    activeLoans,
    loanTypeBreakdown,
    manualLoanTotals,
    rateScenarioDelta,
    baseLoanMonthlyTotal,
  ]);

  const variableReferenceRate = useMemo(() => {
    const variableLoans = activeLoans.filter((loan) => loan.rateType !== "fixed");
    const variableAmount = variableLoans.reduce(
      (sum, loan) => sum + (Number.isFinite(loan.amountNumber) ? loan.amountNumber : 0),
      0,
    );
    if (variableAmount > 0) {
      const weightedSum = variableLoans.reduce(
        (sum, loan) =>
          sum +
          (Number.isFinite(loan.amountNumber) && loan.amountNumber > 0
            ? loan.amountNumber * (Number(loan.interestNumber) || 0)
            : 0),
        0,
      );
      return weightedSum / variableAmount;
    }
    const totalAmount = activeLoans.reduce(
      (sum, loan) => sum + (Number.isFinite(loan.amountNumber) ? loan.amountNumber : 0),
      0,
    );
    if (totalAmount > 0) {
      return (
        activeLoans.reduce(
          (sum, loan) =>
            sum +
            (Number.isFinite(loan.amountNumber) && loan.amountNumber > 0
              ? loan.amountNumber * (Number(loan.interestNumber) || 0)
              : 0),
          0,
        ) / totalAmount
      );
    }
    return null;
  }, [activeLoans]);

  const fixedVsVariableDiff = useMemo(() => {
    if (!Number.isFinite(variableReferenceRate) || variableReferenceRate === null) {
      return null;
    }
    const fixedLoans = activeLoans.filter((loan) => loan.rateType === "fixed");
    if (fixedLoans.length === 0) {
      return null;
    }
    const result = fixedLoans.reduce(
      (acc, loan) => {
        if (!Number.isFinite(loan.amountNumber) || loan.amountNumber <= 0) {
          return acc;
        }
        const fixedRate = Number(loan.interestNumber) || 0;
        const variableMonthlyInterest =
          (loan.amountNumber * variableReferenceRate) / 100 / 12;
        const fixedMonthlyInterest = (loan.amountNumber * fixedRate) / 100 / 12;
        const diff = fixedMonthlyInterest - variableMonthlyInterest;
        acc.totalDifference += diff;
        acc.totalAmount += loan.amountNumber;
        return acc;
      },
      { totalDifference: 0, totalAmount: 0 },
    );
    return result.totalAmount > 0 ? result : null;
  }, [activeLoans, variableReferenceRate]);

  const incomeBreakdown = useMemo(() => {
    const persons = incomePersons.map((person, index) => {
      const table = TAX_TABLE_MAP[person.taxTable] ?? TAX_TABLES[1];
      const gross = Number(person.incomeGross);
      const validGross = Number.isFinite(gross) && gross > 0 ? gross : 0;
      const carBenefit = Number(person.carBenefit);
      const validBenefit = Number.isFinite(carBenefit) && carBenefit > 0 ? carBenefit : 0;
      const taxable = Math.max(validGross - validBenefit, 0);
      const tax = taxable * table.rate;
      const net = Math.max(taxable - tax, 0);
      return {
        ...person,
        gross: validGross,
        carBenefit: validBenefit,
        taxable,
        tax,
        net,
        tableLabel: table.label,
      };
    });
    const totalGross = persons.reduce((sum, person) => sum + person.gross, 0);
    const totalTax = persons.reduce((sum, person) => sum + person.tax, 0);
    const totalNet = persons.reduce((sum, person) => sum + person.net, 0);
    const totalCarBenefit = persons.reduce((sum, person) => sum + person.carBenefit, 0);
    return { persons, totalGross, totalTax, totalNet, totalCarBenefit };
  }, [incomePersons]);

  const netMonthlyIncome =
    incomeBreakdown.totalNet > 0 ? incomeBreakdown.totalNet : null;
  const monthlyTaxAmount = incomeBreakdown.totalTax;
  const normalizedCarBenefit = incomeBreakdown.totalCarBenefit;
  const apiIncome = incomeBreakdown.totalNet > 0 ? incomeBreakdown.totalNet : null;

  const electricityTotals = useMemo(
    () => calculateElectricityMonthlyCost(electricity),
    [electricity],
  );

  const extraMonthlyTotal = useMemo(() => {
    const baseExtra = costItems.reduce(
      (sum, item) => sum + effectiveMonthlyCost(item),
      0,
    );
    return baseExtra + electricityTotals.monthlyCost;
  }, [costItems, electricityTotals.monthlyCost]);
  const sharedCostItems = useMemo(() => costItems.filter((item) => item.shareWithEx), [costItems]);
  const sharedMonthlyTotals = useMemo(
    () =>
      sharedCostItems.reduce(
        (acc, item) => {
          const monthly = monthlyCostValue(item);
          acc.total += monthly;
          acc.myShare += effectiveMonthlyCost(item);
          return acc;
        },
        { total: 0, myShare: 0 },
      ),
    [sharedCostItems],
  );

  const savingsMonthlyTotal = useMemo(
    () => savingsItems.reduce((sum, item) => sum + monthlyCostValue(item), 0),
    [savingsItems],
  );

  const loanMonthlyTotal = result?.totals?.totalMonthlyCost ?? 0;
  const combinedMonthlyPlan = loanMonthlyTotal + extraMonthlyTotal + savingsMonthlyTotal;

  const interestDeductionMonthly = useMemo(() => {
    if (!result?.totals) {
      return 0;
    }
    return calculateInterestDeductionMonthly(result.totals.monthlyInterest);
  }, [result]);

  const effectiveIncome =
    netMonthlyIncome != null
      ? netMonthlyIncome + (taxAdjustmentEnabled ? interestDeductionMonthly : 0)
      : null;
  const incomeForPlan = effectiveIncome ?? null;
  const activeTaxBonus = taxAdjustmentEnabled ? interestDeductionMonthly : 0;
  const amortizationPercentNumber = useMemo(() => {
    if (!activeLoans.length) {
      return 0;
    }
    const totalAmount = activeLoans.reduce((sum, loan) => sum + loan.amountNumber, 0);
    if (totalAmount === 0) {
      return 0;
    }
    const weighted = activeLoans.reduce(
      (sum, loan) => sum + loan.amountNumber * (loan.amortizationNumber || 0),
      0,
    );
    return weighted / totalAmount;
  }, [activeLoans]);

  const baseTotalShare =
    netMonthlyIncome && result?.totals ? combinedMonthlyPlan / netMonthlyIncome : null;
  const baseExtraShare =
    netMonthlyIncome && result ? extraMonthlyTotal / netMonthlyIncome : null;
  const activeLoanPrincipal = result?.totals?.loanAmount ?? manualLoanTotals.totalAmount;
  const currentLoanToValue =
    hasPropertyValue && activeLoanPrincipal > 0 ? activeLoanPrincipal / propertyValueNumber : null;
  const amortizationRequirement = useMemo(() => {
    if (!hasPropertyValue || !activeLoanPrincipal || propertyValueNumber <= 0) {
      return null;
    }
    const ratio = activeLoanPrincipal / propertyValueNumber;
    let percent = 0;
    if (ratio > 0.7) {
      percent = 2;
    } else if (ratio > 0.5) {
      percent = 1;
    }
    return { percent, ratio };
  }, [hasPropertyValue, activeLoanPrincipal, propertyValueNumber]);

  const totalIncomeShare =
    incomeForPlan && incomeForPlan > 0 ? combinedMonthlyPlan / incomeForPlan : null;
  const extraIncomeShare =
    incomeForPlan && incomeForPlan > 0 ? extraMonthlyTotal / incomeForPlan : null;
  const loanIncomeShare =
    incomeForPlan && incomeForPlan > 0 ? loanMonthlyTotal / incomeForPlan : null;
  const savingsIncomeShare =
    incomeForPlan && incomeForPlan > 0 ? savingsMonthlyTotal / incomeForPlan : null;

  const remainingNetIncome =
    incomeForPlan !== null ? incomeForPlan - combinedMonthlyPlan : null;

  const leftoverShare =
    incomeForPlan && incomeForPlan !== 0
      ? remainingNetIncome / incomeForPlan
      : null;
  const planProgress = clampShare(totalIncomeShare ?? 0) * 100;
  const loanProgress = clampShare(loanIncomeShare ?? 0) * 100;
  const extraProgress = clampShare(extraIncomeShare ?? 0) * 100;
  const savingsProgress = clampShare(savingsIncomeShare ?? 0) * 100;
  const ltvProgress = clampShare(currentLoanToValue ?? 0) * 100;
  const leftoverProgress = clampShare(leftoverShare ?? 0) * 100;
  const hasExtraCosts = costItems.length > 0;
  const usingAutoFuturePercent = futureAmortizationPercent.trim() === "";
  const budgetStatus =
    remainingNetIncome == null
      ? null
      : remainingNetIncome < 0
        ? "Underskott"
        : "Överskott";
  const statusMessage =
    remainingNetIncome == null
      ? ""
      : remainingNetIncome < 0
        ? "Din nuvarande plan överskrider nettolönen – se över kostnaderna eller öka inkomsten."
        : "Din plan klarar sig med pengar över efter att kostnaderna är betalda.";

  const derivedFuturePercent = useMemo(() => {
    if (usingAutoFuturePercent) {
      if (!Number.isFinite(amortizationPercentNumber)) {
        return null;
      }
      if (amortizationPercentNumber >= 1) {
        return Math.max(amortizationPercentNumber - 1, 1);
      }
      return Math.max(amortizationPercentNumber, 0);
    }
    const typed = Number(futureAmortizationPercent);
    return Number.isFinite(typed) ? typed : null;
  }, [usingAutoFuturePercent, futureAmortizationPercent, amortizationPercentNumber]);

  const futureScenario = useMemo(() => {
    if (!result?.totals) {
      return null;
    }
    if (derivedFuturePercent === null || derivedFuturePercent < 0) {
      return null;
    }
    const futureMonthlyAmortization =
      (result.totals.loanAmount * (derivedFuturePercent / 100)) / 12;
    const futureTotalMonthlyCost = result.totals.monthlyInterest + futureMonthlyAmortization;
    const futureCombinedPlan = futureTotalMonthlyCost + extraMonthlyTotal + savingsMonthlyTotal;
    const incomeForScenario = incomeForPlan ?? netMonthlyIncome ?? 0;
    const futureShare = futureCombinedPlan / incomeForScenario;
    const futureLeftover = incomeForScenario - futureCombinedPlan;
    return {
      percentValue: derivedFuturePercent,
      futureMonthlyAmortization,
      futureTotalMonthlyCost,
      futureCombinedPlan,
      futureShare,
      futureLeftover,
    };
  }, [result, derivedFuturePercent, extraMonthlyTotal, savingsMonthlyTotal, incomeForPlan]);

  useEffect(() => {
    if (!futureScenario && scenarioMode === "future") {
      setScenarioMode("current");
    }
  }, [futureScenario, scenarioMode]);

  const futureBudgetStatus =
    futureScenario && futureScenario.futureLeftover != null
      ? futureScenario.futureLeftover < 0
        ? "Underskott"
        : "Överskott"
      : null;
  const futureStatusMessage = futureScenario
    ? futureScenario.futureLeftover < 0
      ? "Din plan efter amorteringskravet överskrider nettolönen – se över kostnaderna eller öka inkomsten."
      : "Din plan efter amorteringskravet klarar sig med pengar över efter att kostnaderna är betalda."
    : "";
  const scenarioDifferenceMonthly = futureScenario
    ? futureScenario.futureCombinedPlan - combinedMonthlyPlan
    : null;
  const scenarioDifferenceAbs =
    scenarioDifferenceMonthly != null ? Math.abs(scenarioDifferenceMonthly) : null;
  const scenarioDifferenceDirection =
    scenarioDifferenceMonthly != null
      ? scenarioDifferenceMonthly > 0
        ? "mer"
        : scenarioDifferenceMonthly < 0
          ? "mindre"
          : "oförändrat"
      : null;
  const incomeBase = incomeForPlan ?? result?.income ?? null;
  const futureLoanShare =
    futureScenario && incomeBase
      ? futureScenario.futureTotalMonthlyCost / incomeBase
      : null;
  const isFutureView = scenarioMode === "future" && Boolean(futureScenario);
  const viewLoanMonthly = isFutureView
    ? futureScenario.futureTotalMonthlyCost
    : loanMonthlyTotal;
  const viewCombinedPlan = isFutureView
    ? futureScenario.futureCombinedPlan
    : combinedMonthlyPlan;
  const viewMonthlyAmortization = isFutureView
    ? futureScenario.futureMonthlyAmortization
    : result?.monthlyAmortization ?? 0;
  const viewAmortizationPercent = isFutureView
    ? futureScenario.percentValue
    : result?.amortizationPercent ?? amortizationPercentNumber;
  const viewTotalShare = isFutureView
    ? futureScenario.futureShare
    : totalIncomeShare;
  const viewLoanShare = isFutureView ? futureLoanShare : loanIncomeShare;
  const viewExtraShare = extraIncomeShare;
  const viewRemainingNetIncome = isFutureView
    ? futureScenario?.futureLeftover ?? null
    : remainingNetIncome;
  const viewBudgetStatus = isFutureView ? futureBudgetStatus : budgetStatus;
  const viewStatusMessage = isFutureView ? futureStatusMessage : statusMessage;

  const loanForecastData = useMemo(() => {
    if (!result?.totals) {
      return [];
    }
    if (!Number.isFinite(amortizationPercentNumber) || amortizationPercentNumber <= 0) {
      return [];
    }
    const yearlyAmortization = result.totals.loanAmount * (amortizationPercentNumber / 100);
    const years = Math.max(1, forecastYears);
    let remaining = result.totals.loanAmount;
    const rows = [];
    for (let year = 0; year <= years; year += 1) {
      rows.push({
        year,
        remaining: Math.max(remaining, 0),
      });
      remaining -= yearlyAmortization;
    }
    return rows;
  }, [result, amortizationPercentNumber, forecastYears]);

  const forecastMaxRemaining = loanForecastData.reduce(
    (max, entry) => Math.max(max, entry.remaining),
    0,
  );
  const forecastChartPoints = loanForecastData.length
    ? loanForecastData.map((entry, index) => {
        const x =
          loanForecastData.length <= 1
            ? 0
            : (index / (loanForecastData.length - 1)) * 100;
        const y =
          forecastMaxRemaining === 0
            ? 100
            : 100 - (entry.remaining / forecastMaxRemaining) * 100;
        return {
          x,
          y,
          remaining: entry.remaining,
          year: entry.year,
        };
      })
    : [];
  const forecastPolyline = forecastChartPoints.length
    ? forecastChartPoints.map((point) => `${point.x},${point.y}`).join(" ")
    : "";
  const forecastAreaPoints = forecastPolyline
    ? `${forecastPolyline} 100,100 0,100`
    : "";
  const forecastStartPoint = forecastChartPoints[0] ?? null;
  const forecastEndPoint =
    forecastChartPoints.length > 1
      ? forecastChartPoints[forecastChartPoints.length - 1]
      : forecastChartPoints[0] ?? null;
  const forecastStartValue = loanForecastData[0]?.remaining ?? 0;
  const forecastEndValue =
    loanForecastData.length > 0
      ? loanForecastData[loanForecastData.length - 1].remaining
      : 0;

  const savingsForecastData = useMemo(() => {
    const yearlyContribution = savingsMonthlyTotal * 12;
    const years = Math.max(1, savingsForecastYears);
    const rows = [];
    let balance = 0;
    for (let year = 0; year <= years; year += 1) {
      rows.push({
        year,
        balance,
      });
      balance = (balance + yearlyContribution) * (1 + SavingsGrowthRate);
    }
    return rows;
  }, [savingsMonthlyTotal, savingsForecastYears]);

  const savingsProjectedTotal =
    savingsForecastData.length > 0
      ? savingsForecastData[savingsForecastData.length - 1].balance
      : 0;
  const forecastLtvData = hasPropertyValue
    ? loanForecastData.map((row) => ({
        ...row,
        ltv: propertyValueNumber > 0 ? row.remaining / propertyValueNumber : null,
      }))
    : [];
  const finalForecastLtv =
    forecastLtvData.length > 0
      ? forecastLtvData[forecastLtvData.length - 1].ltv
      : currentLoanToValue;
  const combinedLoanOverview = useMemo(() => {
    if (!result?.loans?.length) {
      return null;
    }
    return result.loans.map((loan) => ({
      id: loan.id,
      name: loan.name,
      monthlyInterest: loan.monthlyInterest,
      monthlyAmortization: loan.monthlyAmortization,
      totalMonthlyCost: loan.totalMonthlyCost,
    }));
  }, [result]);

  const costSummaryRows = useMemo(() => {
    if (!result?.totals) {
      return [];
    }
    const rows = [
      {
        label: "Bolånekostnad",
        amount: result.totals.totalMonthlyCost,
        originalAmount: result.totals.totalMonthlyCost,
        annual: result.totals.totalMonthlyCost * 12,
      },
    ];
    costItems.forEach((item) => {
      const monthly = effectiveMonthlyCost(item);
      const baseline = monthlyCostValue(item);
      const sharedText = item.shareWithEx ? " (Din del av gemensam kostnad)" : "";
      rows.push({
        label: item.name ? item.name + sharedText : "Övrig post",
        amount: monthly,
        originalAmount: baseline,
        annual: monthly * 12,
      });
    });
    if (electricityTotals.monthlyCost > 0) {
      rows.push({
        label: "Elförbrukning",
        amount: electricityTotals.monthlyCost,
        originalAmount: electricityTotals.monthlyCost,
        annual: electricityTotals.monthlyCost * 12,
      });
    }
    savingsItems.forEach((item) => {
      const monthly = monthlyCostValue(item);
      rows.push({
        label: item.name ? `Sparande – ${item.name}` : "Sparande",
        amount: monthly,
        originalAmount: monthly,
        annual: monthly * 12,
      });
    });
    rows.push({
      label: "Totalt att lägga undan",
      amount: combinedMonthlyPlan,
      originalAmount: combinedMonthlyPlan,
      annual: combinedMonthlyPlan * 12,
      isTotal: true,
    });
    return rows;
  }, [
    result,
    costItems,
    savingsItems,
    electricityTotals.monthlyCost,
    combinedMonthlyPlan,
  ]);

  const scenarioCostSummaryRows = useMemo(() => {
    if (!futureScenario) {
      return costSummaryRows;
    }
    return costSummaryRows.map((row) => {
      if (row.label === "Bolånekostnad") {
        const amount = futureScenario.futureTotalMonthlyCost;
        return {
          ...row,
          amount,
          annual: amount * 12,
        };
      }
      if (row.isTotal) {
        const amount = futureScenario.futureCombinedPlan;
        return {
          ...row,
          amount,
          annual: amount * 12,
        };
      }
      return row;
    });
  }, [costSummaryRows, futureScenario]);
  const activeCostSummaryRows =
    isFutureView && futureScenario ? scenarioCostSummaryRows : costSummaryRows;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        return;
      }
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed === "object") {
        if (
          parsed.incomePersons ||
          parsed.form ||
          parsed.costItems ||
          parsed.savingsItems ||
          parsed.electricity ||
          parsed.futureAmortizationPercent ||
          parsed.loans ||
          parsed.savingsForecastYears !== undefined
        ) {
          if (parsed.incomePersons) {
            setIncomePersons(normalizeIncomePersons(parsed.incomePersons));
          } else if (parsed.form) {
            setIncomePersons(
              normalizeIncomePersons([
                {
                  name: parsed.form.personName ?? "Person 1",
                  incomeGross: parsed.form.incomeGross ?? parsed.form.income ?? "",
                  taxTable: parsed.form.taxTable ?? "30",
                  carBenefit: parsed.form.carBenefit ?? "",
                },
              ]),
            );
          }
          if (parsed.propertyInfo) {
            setPropertyInfo((prev) => ({ ...prev, ...parsed.propertyInfo }));
          }
          if (parsed.costItems) {
            setCostItems(normalizeSavedCosts(parsed.costItems));
          }
          if (parsed.savingsItems) {
            setSavingsItems(normalizeSavedCosts(parsed.savingsItems));
          }
          if (parsed.loans) {
            const restored = normalizeSavedLoans(parsed.loans);
            setLoans(
              restored.length > 0
                ? restored
                : createInitialLoans(),
            );
          }
          if (parsed.electricity) {
            setElectricity((prev) => ({ ...prev, ...parsed.electricity }));
          }
          if (parsed.futureAmortizationPercent !== undefined) {
            setFutureAmortizationPercent(String(parsed.futureAmortizationPercent));
          }
          if (typeof parsed.taxAdjustmentEnabled === "boolean") {
            setTaxAdjustmentEnabled(parsed.taxAdjustmentEnabled);
          }
          if (typeof parsed.savingsForecastYears === "number") {
            setSavingsForecastYears(parsed.savingsForecastYears);
          }
        } else if (parsed !== null && parsed !== undefined) {
          const legacyIncome =
            typeof parsed === "number"
              ? parsed
              : typeof parsed === "string"
                ? Number(parsed)
                : undefined;
          setIncomePersons(
            normalizeIncomePersons([
              {
                name: "Person 1",
                incomeGross: Number.isFinite(legacyIncome) ? legacyIncome : "",
              },
            ]),
          );
        }
      }
    } catch (err) {
      console.error("Failed to load saved data", err);
    }
    setInitialLoadDone(true);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimeout.current) {
        clearTimeout(feedbackTimeout.current);
      }
    };
  }, []);

  useEffect(() => {
    setNewCost((prev) => {
      const nextCategoryId = ensureCategoryId(prev.categoryId);
      return prev.categoryId === nextCategoryId
        ? prev
        : { ...prev, categoryId: nextCategoryId };
    });
    setEditingCost((prev) => {
      const nextCategoryId = ensureCategoryId(prev.categoryId);
      return prev.categoryId === nextCategoryId
        ? prev
        : { ...prev, categoryId: nextCategoryId };
    });
  }, [ensureCategoryId]);

  const showFeedback = (message) => {
    if (feedbackTimeout.current) {
      clearTimeout(feedbackTimeout.current);
    }
    setFeedback(message);
    feedbackTimeout.current = setTimeout(() => setFeedback(""), 4000);
  };

  const calculate = useCallback(async (payload) => {
    const snapshot = JSON.stringify(payload);
    setStatus("loading");
    setError("");

    try {
      const response = await fetch(`${API_BASE_URL}/api/calculate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data?.error ?? "Misslyckades att räkna på bolånet.");
      }

      const calculation = await response.json();
      setResult(calculation);
      setStatus("success");
      setHasCalculated(true);
      lastSubmittedSnapshot.current = snapshot;
    } catch (err) {
      setStatus("error");
      setError(err.message || "Något gick fel.");
    }
  }, []);

  const resetForm = () => {
    setIncomePersons(normalizeIncomePersons([]));
    setLoans(createInitialLoans());
    setCostItems([]);
    setNewCost(initialExtraCost);
    setSavingsItems([]);
    setNewSavings(initialSavingsItem);
    setEditingCostId(null);
    setEditingCost(initialExtraCost);
    setCostCategories(DEFAULT_CATEGORIES);
    setNewCategoryName("");
    setEditingCategoryId(null);
    setEditingCategoryName("");
    setPropertyInfo(initialPropertyInfo);
    setResult(null);
    setError("");
    setStatus("idle");
    setHasCalculated(false);
    setFutureAmortizationPercent("0");
    lastSubmittedSnapshot.current = "";
  };

  const handleSaveForm = () => {
    try {
      const payload = {
        incomePersons,
        loans,
        costItems,
        savingsItems,
        electricity,
        propertyInfo,
        futureAmortizationPercent,
        taxAdjustmentEnabled,
        savingsForecastYears,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      showFeedback("Uppgifter sparade ✅");
    } catch (err) {
      console.error("Failed to save data", err);
      showFeedback("Kunde inte spara uppgifterna.");
    }
  };

  const handleClearSaved = () => {
    localStorage.removeItem(STORAGE_KEY);
    showFeedback("Sparade uppgifter borttagna.");
  };

  const handleNewCostChange = (event) => {
    const { name, value, type, checked } = event.target;
    setNewCost((prev) => ({ ...prev, [name]: type === "checkbox" ? checked : value }));
  };

  const handleEditingCostChange = (event) => {
    const { name, value, type, checked } = event.target;
    setEditingCost((prev) => ({ ...prev, [name]: type === "checkbox" ? checked : value }));
  };

  const handleElectricityChange = (event) => {
    const { name, value } = event.target;
    setElectricity((prev) => ({ ...prev, [name]: value }));
  };

  const handlePropertyInfoChange = (event) => {
    const { name, value } = event.target;
    setPropertyInfo((prev) => ({ ...prev, [name]: value }));
  };

  const handleFutureAmortizationChange = (event) => {
    setFutureAmortizationPercent(event.target.value);
  };

  const handleIncomePersonChange = (personId, field, value) => {
    setIncomePersons((prev) =>
      prev.map((person) =>
        person.id === personId ? { ...person, [field]: value } : person,
      ),
    );
  };

  const addIncomePerson = () => {
    setIncomePersons((prev) => [
      ...prev,
      createIncomePerson({ name: `Person ${prev.length + 1}` }),
    ]);
  };

  const removeIncomePerson = (personId) => {
    setIncomePersons((prev) => (prev.length <= 1 ? prev : prev.filter((person) => person.id !== personId)));
  };

  const handleLoanChange = (loanId, field, value) => {
    setLoans((prev) =>
      prev.map((loan) => {
        if (loan.id !== loanId) {
          return loan;
        }
        if (field === "rateType" && value !== "fixed") {
          return { ...loan, rateType: value, fixedTermYears: "" };
        }
        return { ...loan, [field]: value };
      }),
    );
  };

  const addLoanRow = () => {
    if (loans.length >= MAX_LOANS) {
      showFeedback(`Du kan som mest lägga in ${MAX_LOANS} lån.`);
      return;
    }
    setLoans((prev) => [...prev, createLoanRow(prev.length)]);
  };

  const removeLoanRow = (loanId) => {
    if (loans.length <= 1) {
      return;
    }
    setLoans((prev) => prev.filter((loan) => loan.id !== loanId));
  };

  const handleNewSavingsChange = (event) => {
    const { name, value } = event.target;
    setNewSavings((prev) => ({ ...prev, [name]: value }));
  };

  const addSavingsItem = () => {
    const amountValue = Number(newSavings.amount);
    if (!newSavings.name.trim() || !Number.isFinite(amountValue) || amountValue <= 0) {
      showFeedback("Ange namn och belopp (större än 0 kr).");
      return;
    }
    const item = {
      id: createCostId(),
      name: newSavings.name.trim(),
      amount: amountValue,
      frequency: formatCostFrequency(newSavings.frequency),
    };
    setSavingsItems((prev) => [...prev, item]);
    setNewSavings(initialSavingsItem);
  };

  const removeSavingsItem = (id) => {
    setSavingsItems((prev) => prev.filter((item) => item.id !== id));
  };

  const toggleTaxAdjustment = () => {
    setTaxAdjustmentEnabled((prev) => !prev);
  };

  const handleForecastYearsChange = (event) => {
    setForecastYears(Number(event.target.value));
  };

  const handleExportCostSummary = () => {
    const rows = activeCostSummaryRows;
    if (!result || rows.length === 0) {
      return;
    }
    const headers = ["Kategori", "Belopp (kr/mån)", "Din del (kr/mån)", "Belopp (kr/år)"];
    const csvRows = [
      headers,
      ...rows.map((row) => [
        row.label,
        row.amount.toFixed(2),
        row.originalAmount ? row.originalAmount.toFixed(2) : row.amount.toFixed(2),
        row.annual.toFixed(2),
      ]),
    ];
    const csvContent = csvRows
      .map((row) =>
        row
          .map((field) => `"${String(field).replace(/"/g, '""')}"`)
          .join(";"),
      )
      .join("\n");
    const blob = new Blob(["\uFEFF" + csvContent], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "budget-kostnader.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPdf = () => {
    if (!result?.totals) {
      showFeedback("Gör en kalkyl innan du exporterar.");
      return;
    }
    window.print();
  };

  useEffect(() => {
    if (!initialLoadDone) {
      return;
    }
    try {
      const payload = {
        incomePersons,
        loans,
        costItems,
        savingsItems,
        electricity,
        propertyInfo,
        futureAmortizationPercent,
        taxAdjustmentEnabled,
        savingsForecastYears,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.error("Failed to auto-save data", err);
    }
  }, [
    incomePersons,
    loans,
    costItems,
    savingsItems,
    electricity,
    propertyInfo,
    futureAmortizationPercent,
    taxAdjustmentEnabled,
    savingsForecastYears,
    initialLoadDone,
  ]);

  const calculationPayload = useMemo(() => {
    if (!canCalculateLoans(activeLoans)) {
      return null;
    }
    const payload = {
      loans: activeLoans.map((loan) => ({
        id: loan.id,
        name: loan.name || "",
        loanAmount: loan.amountNumber,
        annualInterestRate: loan.interestNumber,
        amortizationPercent: loan.amortizationNumber,
        rateType: loan.rateType === "fixed" ? "fixed" : "variable",
        fixedTermYears: Number(loan.fixedTermYears) || 0,
      })),
    };
    if (apiIncome && apiIncome > 0) {
      payload.income = apiIncome;
    }
    return payload;
  }, [activeLoans, apiIncome]);

  useEffect(() => {
    if (!calculationPayload) {
      if (hasCalculated) {
        setResult(null);
        setHasCalculated(false);
      }
      return undefined;
    }
    if (status === "loading") {
      return undefined;
    }
    const snapshot = JSON.stringify(calculationPayload);
    if (snapshot === lastSubmittedSnapshot.current) {
      return undefined;
    }
    const timeoutId = setTimeout(() => {
      calculate(calculationPayload);
    }, 350);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [calculationPayload, status, calculate, hasCalculated]);

  const addCostItem = () => {
    const amountValue = Number(newCost.amount);
    if (!newCost.name.trim() || !Number.isFinite(amountValue) || amountValue <= 0) {
      showFeedback("Ange namn och belopp (större än 0 kr).");
      return;
    }
    const categoryId = ensureCategoryId(newCost.categoryId);
    const item = {
      id: createCostId(),
      name: newCost.name.trim(),
      amount: amountValue,
      frequency: formatCostFrequency(newCost.frequency),
      shareWithEx: Boolean(newCost.shareWithEx),
      categoryId,
    };
    setCostItems((prev) => [...prev, item]);
    setNewCost((prev) => ({
      ...initialExtraCost,
      frequency: prev.frequency,
      categoryId,
    }));
  };

  const startEditCostItem = (item) => {
    setEditingCostId(item.id);
    setEditingCost({
      name: item.name,
      amount: String(item.amount),
      frequency: item.frequency,
      shareWithEx: Boolean(item.shareWithEx),
      categoryId: ensureCategoryId(item.categoryId),
    });
  };

  const cancelEditingCost = () => {
    setEditingCostId(null);
    setEditingCost({
      ...initialExtraCost,
      categoryId: ensureCategoryId(initialExtraCost.categoryId),
    });
  };

  const saveEditingCostItem = () => {
    if (!editingCostId) {
      return;
    }
    const amountValue = Number(editingCost.amount);
    if (!editingCost.name.trim() || !Number.isFinite(amountValue) || amountValue <= 0) {
      showFeedback("Ange namn och belopp (större än 0 kr).");
      return;
    }
    setCostItems((prev) =>
      prev.map((item) =>
        item.id === editingCostId
          ? {
              ...item,
              name: editingCost.name.trim(),
              amount: amountValue,
              frequency: formatCostFrequency(editingCost.frequency),
              shareWithEx: Boolean(editingCost.shareWithEx),
              categoryId: ensureCategoryId(editingCost.categoryId),
            }
          : item,
      ),
    );
    cancelEditingCost();
    showFeedback("Budgetpost uppdaterad ✅");
  };

  const removeCostItem = (id) => {
    setCostItems((prev) => prev.filter((item) => item.id !== id));
    if (editingCostId === id) {
      cancelEditingCost();
    }
  };

  const handleAddCategory = () => {
    const trimmed = newCategoryName.trim();
    if (!trimmed) {
      showFeedback("Ange ett kategorinamn.");
      return;
    }
    if (
      costCategories.some(
        (category) => category.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      showFeedback("Kategorin finns redan.");
      return;
    }
    const newCategory = {
      id: createCategoryId(),
      name: trimmed,
    };
    setCostCategories((prev) => [...prev, newCategory]);
    setNewCategoryName("");
    showFeedback("Ny kategori tillagd ✅");
  };

  const startEditCategory = (category) => {
    setEditingCategoryId(category.id);
    setEditingCategoryName(category.name);
  };

  const cancelEditCategory = () => {
    setEditingCategoryId(null);
    setEditingCategoryName("");
  };

  const saveEditCategory = () => {
    if (!editingCategoryId) {
      return;
    }
    const trimmed = editingCategoryName.trim();
    if (!trimmed) {
      showFeedback("Ange ett kategorinamn.");
      return;
    }
    if (
      costCategories.some(
        (category) =>
          category.id !== editingCategoryId &&
          category.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      showFeedback("Det finns redan en kategori med det namnet.");
      return;
    }
    setCostCategories((prev) =>
      prev.map((category) =>
        category.id === editingCategoryId ? { ...category, name: trimmed } : category,
      ),
    );
    cancelEditCategory();
    showFeedback("Kategori uppdaterad ✅");
  };

  const handleRemoveCategory = (categoryId) => {
    if (costCategories.length <= 1) {
      showFeedback("Du behöver minst en kategori.");
      return;
    }
    const updatedCategories = costCategories.filter((category) => category.id !== categoryId);
    const fallbackId = updatedCategories[0]?.id ?? DEFAULT_CATEGORIES[0].id;
    setCostCategories(updatedCategories);
    setCostItems((prev) =>
      prev.map((item) =>
        item.categoryId === categoryId ? { ...item, categoryId: fallbackId } : item,
      ),
    );
    setNewCost((prev) =>
      prev.categoryId === categoryId ? { ...prev, categoryId: fallbackId } : prev,
    );
    setEditingCost((prev) =>
      prev.categoryId === categoryId ? { ...prev, categoryId: fallbackId } : prev,
    );
    if (editingCategoryId === categoryId) {
      cancelEditCategory();
    }
    showFeedback("Kategori borttagen.");
  };

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Budgetapp – hushållsekonomi</p>
          <h1>Bolånekalkyl</h1>
          <p className="lead">
            Fyll i dina uppgifter för att se hur ränta och amortering påverkar
            månadskostnaden jämfört med din nettolön per månad.
          </p>
        </div>
        {netMonthlyIncome && (
          <div className="highlight">
            <p>Månadsinkomst (netto)</p>
            <strong>{SEK.format(netMonthlyIncome)}</strong>
          </div>
        )}
      </header>
      <main className="content">
        <form className="calculator-form" onSubmit={(event) => event.preventDefault()}>
          <section className="form-section">
            <div className="section-header">
              <div>
                <h2>Inkomst & skatt</h2>
                <p>Lägg till en rad per person så räknar vi ut nettolönen automatiskt.</p>
              </div>
            </div>
            <div className="income-person-grid">
              {incomePersons.map((person, index) => {
                const summary = incomeBreakdown.persons[index] ?? {};
                return (
                  <article key={person.id} className="income-person-card">
                    <div className="person-card-header">
                      <label>
                        <span>Namn</span>
                        <input
                          type="text"
                          value={person.name}
                          onChange={(event) =>
                            handleIncomePersonChange(person.id, "name", event.target.value)
                          }
                          placeholder={`Person ${index + 1}`}
                        />
                      </label>
                      {incomePersons.length > 1 && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => removeIncomePerson(person.id)}
                        >
                          Ta bort
                        </button>
                      )}
                    </div>
                    <label>
                      <span>Brutto (kr / mån)</span>
                      <input
                        type="number"
                        min="0"
                        value={person.incomeGross}
                        onChange={(event) =>
                          handleIncomePersonChange(person.id, "incomeGross", event.target.value)
                        }
                        placeholder="t.ex. 42000"
                      />
                    </label>
                    <label>
                      <span>Skattetabell</span>
                      <select
                        value={person.taxTable}
                        onChange={(event) =>
                          handleIncomePersonChange(person.id, "taxTable", event.target.value)
                        }
                      >
                        {TAX_TABLES.map((table) => (
                          <option key={`${person.id}-${table.id}`} value={table.id}>
                            {table.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Brutolöneavdrag (t.ex. tjänstebil)</span>
                      <input
                        type="number"
                        min="0"
                        value={person.carBenefit}
                        onChange={(event) =>
                          handleIncomePersonChange(person.id, "carBenefit", event.target.value)
                        }
                        placeholder="t.ex. 4000"
                      />
                    </label>
                    <div className="person-net-summary">
                      <div>
                        <p>Nettolön</p>
                        <h4>{SEK.format(summary.net ?? 0)}</h4>
                      </div>
                      <span>Skatt: {SEK.format(summary.tax ?? 0)} / mån</span>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="income-actions">
              <button type="button" className="ghost" onClick={addIncomePerson}>
                Lägg till person
              </button>
              <span>{incomePersons.length} personer</span>
            </div>
            <div className="income-summary-card">
              <div>
                <p>Nettolön (utan jämkning)</p>
                <h3>{SEK.format(netMonthlyIncome ?? 0)}</h3>
              </div>
              <div className="income-summary-grid">
                <div>
                  <span>Bruttoinkomst (totalt)</span>
                  <strong>{SEK.format(incomeBreakdown.totalGross)}</strong>
                </div>
                <div>
                  <span>Skatt per månad</span>
                  <strong>{SEK.format(monthlyTaxAmount)}</strong>
                </div>
                <div>
                  <span>Brutolöneavdrag</span>
                  <strong>{SEK.format(normalizedCarBenefit)}</strong>
                </div>
                <div>
                  <span>Nettolön (aktiv)</span>
                  <strong>{SEK.format(incomeForPlan ?? netMonthlyIncome ?? 0)}</strong>
                </div>
                <div>
                  <span>Jämkningspåslag</span>
                  <strong>{SEK.format(activeTaxBonus)}</strong>
                </div>
              </div>
            </div>
          </section>
          <section className="form-section">
            <div className="section-header">
              <div>
                <h2>Fastighetsinformation</h2>
                <p>Ange bostadens värde för att se belåningsgrad och låneutrymme.</p>
              </div>
            </div>
            <div className="property-grid">
              <label>
                <span>Beskrivning / adress</span>
                <input
                  type="text"
                  name="name"
                  value={propertyInfo.name}
                  onChange={handlePropertyInfoChange}
                  placeholder="t.ex. Villa Solrosen"
                />
              </label>
              <label>
                <span>Värdering (kr)</span>
                <input
                  type="number"
                  min="0"
                  name="value"
                  value={propertyInfo.value}
                  onChange={handlePropertyInfoChange}
                  placeholder="t.ex. 5 000 000"
                />
                {propertyValuePreview && (
                  <span className="input-preview">{propertyValuePreview}</span>
                )}
              </label>
            </div>
            {hasPropertyValue && activeLoanPrincipal > 0 && (
              <div className="property-summary">
                <div>
                  <p>Belåningsgrad</p>
                  <h3>{PERCENT.format(currentLoanToValue ?? 0)}</h3>
                  <span>
                    Totala lån {SEK.format(activeLoanPrincipal)} av {SEK.format(propertyValueNumber)} i värde.
                  </span>
                  {amortizationRequirement && (
                    <span>
                      Amorteringskrav enligt regel: <strong>{amortizationRequirement.percent}%</strong> / år
                    </span>
                  )}
                </div>
                <div className="progress muted">
                  <div style={{ width: `${ltvProgress}%` }} />
                </div>
              </div>
            )}
          </section>
          <section className="form-section">
            <div className="section-header">
              <div>
                <h2>Bolån</h2>
                <p>Fördela din bolåneskuld på upp till tre delar med egna villkor.</p>
              </div>
            </div>
            <div className="loan-grid">
              {loans.map((loan, index) => {
                const amountPreview = formatAmountPreview(loan.amount);
                return (
                  <article key={loan.id} className="loan-card">
                    <div className="loan-card-header">
                      <label>
                        <span>Lånenamn</span>
                        <input
                          type="text"
                          value={loan.name}
                          onChange={(event) => handleLoanChange(loan.id, "name", event.target.value)}
                          placeholder={`Lån ${index + 1}`}
                        />
                      </label>
                    </div>
                    <div className="loan-card-grid">
                      <label>
                        <span>Belopp (kr)</span>
                        <input
                          type="number"
                          min="0"
                          value={loan.amount}
                          onChange={(event) => handleLoanChange(loan.id, "amount", event.target.value)}
                          placeholder="t.ex. 1 500 000"
                        />
                        {amountPreview && <span className="input-preview">{amountPreview}</span>}
                      </label>
                      <label>
                        <span>Ränta (%)</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={loan.annualInterestRate}
                          onChange={(event) =>
                            handleLoanChange(loan.id, "annualInterestRate", event.target.value)
                          }
                          placeholder="t.ex. 4.2"
                        />
                      </label>
                      <label>
                        <span>Amortering (% av lån/år)</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          value={loan.amortizationPercent}
                          onChange={(event) =>
                            handleLoanChange(loan.id, "amortizationPercent", event.target.value)
                          }
                          placeholder="t.ex. 2"
                        />
                      </label>
                      <label>
                        <span>Räntetyp</span>
                        <select
                          value={loan.rateType || "variable"}
                          onChange={(event) =>
                            handleLoanChange(loan.id, "rateType", event.target.value)
                          }
                        >
                          <option value="variable">Rörlig</option>
                          <option value="fixed">Bunden</option>
                        </select>
                      </label>
                      {loan.rateType === "fixed" && (
                        <label>
                          <span>Bunden (år)</span>
                          <input
                            type="number"
                            min="1"
                            max="30"
                            value={loan.fixedTermYears}
                            onChange={(event) =>
                              handleLoanChange(loan.id, "fixedTermYears", event.target.value)
                            }
                            placeholder="t.ex. 3"
                          />
                        </label>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            {manualLoanAverages && (
              <div className="loan-summary-banner">
                <div>
                  <p>Total skuld</p>
                  <h3>{SEK.format(manualLoanAverages.total)}</h3>
                  <span>Snittränta {manualLoanAverages.effectiveRate.toFixed(2)} %</span>
                </div>
                <div>
                  <p>Månadsränta</p>
                  <strong>{SEK.format(manualLoanAverages.monthlyInterest)}</strong>
                </div>
                <div>
                  <p>Månadsamortering</p>
                  <strong>{SEK.format(manualLoanAverages.monthlyAmortization)}</strong>
                  <span className="metric-note">
                    ≈ {manualLoanAverages.effectiveAmortPercent.toFixed(2)} % / år
                  </span>
                </div>
                {fixedVsVariableDiff && (
                  <div>
                    <p>Bundet vs rörligt</p>
                    <strong>{formatCurrencyDiff(fixedVsVariableDiff.totalDifference)}</strong>
                    <span className="metric-note">
                      Referensränta {Number(variableReferenceRate ?? 0).toFixed(2)}% (rörlig)
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="loan-actions">
              <button
                type="button"
                className="ghost"
                onClick={addLoanRow}
                disabled={loans.length >= MAX_LOANS}
              >
                Lägg till lån
              </button>
              <span>
                {activeLoans.length} av {MAX_LOANS} lån aktiva
              </span>
            </div>
            <div className="field inline">
              <label htmlFor="futureAmortizationPercent">
                Scenario efter amorteringskrav (%)
              </label>
              <input
                id="futureAmortizationPercent"
                name="futureAmortizationPercent"
                type="number"
                min="0"
                step="0.1"
                value={futureAmortizationPercent}
                onChange={handleFutureAmortizationChange}
                placeholder={
                  Number.isFinite(amortizationPercentNumber)
                    ? Math.max(amortizationPercentNumber - 1, 0).toFixed(1)
                    : "1.0"
                }
              />
              <span className="field-note">
                Lämna tomt för att automatiskt minska den genomsnittliga amorteringen med 1 %-enhet
                (dock aldrig under 1%).
              </span>
            </div>
          </section>
          <div className="tax-adjustment-card">
            <label className="tax-toggle">
              <input
                type="checkbox"
                checked={taxAdjustmentEnabled}
                onChange={toggleTaxAdjustment}
              />
              Skattejämkning på ränteavdrag
            </label>
            <p>
              Ger ca <strong>{SEK.format(interestDeductionMonthly)}</strong> extra netto /
              månad.
            </p>
            {!result && (
              <span className="field-note">
                Beloppet räknas ut när du gjort din första kalkyl.
              </span>
            )}
          </div>
          <section className="extra-costs">
            <div className="extra-header">
              <div>
                <h3>Övriga kostnader</h3>
                <p>Lägg till återkommande utgifter som bredband, försäkringar m.m.</p>
              </div>
            </div>
            <div className="electricity-card">
              <div>
                <h4>Elförbrukning</h4>
                <p>Ange total årsförbrukning (kWh/år) och snittpris. Vi räknar om till månadsnivå.</p>
              </div>
              <div className="electricity-inputs">
                <label>
                  <span>Årsförbrukning (kWh / år)</span>
                  <input
                    type="number"
                    min="0"
                    name="consumption"
                    value={electricity.consumption}
                    onChange={handleElectricityChange}
                    placeholder="t.ex. 250"
                  />
                </label>
                <label>
                  <span>Snittpris (kr / kWh)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    name="price"
                    value={electricity.price}
                    onChange={handleElectricityChange}
                    placeholder="t.ex. 1.5"
                  />
                </label>
                <div className="electricity-summary">
                  <span>Uträknad elkostnad</span>
                  <strong>{SEK.format(electricityTotals.monthlyCost)} / mån</strong>
                  <span>
                    ≈ {NUMBER.format(electricityTotals.monthlyKwh || 0)} kWh per månad
                  </span>
                </div>
              </div>
            </div>
            <div className="cost-inputs">
              <input
                type="text"
                name="name"
                placeholder="Post (t.ex. bredband)"
                value={newCost.name}
                onChange={handleNewCostChange}
              />
              <input
                type="number"
                name="amount"
                placeholder="Belopp"
                min="0"
                value={newCost.amount}
                onChange={handleNewCostChange}
              />
              <select
                name="frequency"
                value={newCost.frequency}
                onChange={handleNewCostChange}
              >
                <option value="monthly">per månad</option>
                <option value="quarterly">per kvartal</option>
                <option value="yearly">per år</option>
                <option value="term">per termin (≈6 mån)</option>
                <option value="season">per säsong (≈4 mån)</option>
              </select>
              <select
                name="categoryId"
                value={newCost.categoryId}
                onChange={handleNewCostChange}
              >
                {costCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <label className="share-toggle">
                <input
                  type="checkbox"
                  name="shareWithEx"
                  checked={newCost.shareWithEx}
                  onChange={handleNewCostChange}
                />
                Dela kostnaden (vi betalar hälften var)
              </label>
              <button
                type="button"
                className="ghost add-cost"
                onClick={addCostItem}
              >
                Lägg till post
              </button>
            </div>
            {costItems.length > 0 ? (
              <ul className="cost-list">
                {costItems.map((item) => {
                  const isEditing = editingCostId === item.id;
                  const editingPreviewItem = isEditing
                    ? {
                        ...item,
                        name: editingCost.name,
                        amount: Number(editingCost.amount) || 0,
                        frequency: formatCostFrequency(editingCost.frequency),
                      }
                    : null;
                  return (
                    <li
                      key={item.id}
                      className={`cost-item ${isEditing ? "editing" : ""}`}
                    >
                      {isEditing ? (
                        <>
                        <div className="cost-edit-grid">
                            <label>
                            <span>Postnamn</span>
                            <input
                              type="text"
                              name="name"
                              value={editingCost.name}
                              onChange={handleEditingCostChange}
                            />
                          </label>
                          <label>
                            <span>Belopp</span>
                            <input
                              type="number"
                              min="0"
                              name="amount"
                              value={editingCost.amount}
                              onChange={handleEditingCostChange}
                            />
                          </label>
                          <label>
                            <span>Frekvens</span>
                            <select
                              name="frequency"
                              value={editingCost.frequency}
                              onChange={handleEditingCostChange}
                            >
                              <option value="monthly">per månad</option>
                              <option value="quarterly">per kvartal</option>
                              <option value="yearly">per år</option>
                              <option value="term">per termin (≈6 mån)</option>
                              <option value="season">per säsong (≈4 mån)</option>
                            </select>
                          </label>
                          <label className="share-toggle">
                            <span>Dela kostnaden?</span>
                            <input
                              type="checkbox"
                              name="shareWithEx"
                              checked={Boolean(editingCost.shareWithEx)}
                              onChange={handleEditingCostChange}
                            />
                          </label>
                          <label>
                            <span>Kategori</span>
                            <select
                              name="categoryId"
                              value={editingCost.categoryId}
                              onChange={handleEditingCostChange}
                            >
                              {costCategories.map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="cost-edit-actions">
                          <span className="cost-monthly">
                            {SEK.format(effectiveMonthlyCost(editingPreviewItem))} / mån
                          </span>
                          <div className="cost-edit-buttons">
                            <button type="button" className="ghost" onClick={saveEditingCostItem}>
                              Spara
                            </button>
                            <button type="button" className="link-button" onClick={cancelEditingCost}>
                              Avbryt
                            </button>
                          </div>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <strong>{item.name}</strong>
                          <span className="cost-meta">
                            {SEK.format(item.amount)} /{" "}
                            {item.frequency === "yearly"
                              ? "år"
                              : item.frequency === "quarterly"
                                ? "kvartal"
                                : item.frequency === "term"
                                  ? "termin"
                                  : item.frequency === "season"
                                    ? "säsong"
                                    : "månad"}
                          </span>
                            <span className="cost-meta">
                              {costCategories.find((cat) => cat.id === item.categoryId)?.name ||
                                "Kategori"}
                            </span>
                            {item.shareWithEx && (
                              <span className="cost-meta shared">Din del (50%)</span>
                            )}
                          </div>
                        <div className="cost-actions">
                          <span className="cost-monthly">
                            {SEK.format(effectiveMonthlyCost(item))} / mån
                          </span>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => startEditCostItem(item)}
                          >
                            Redigera
                          </button>
                          <button
                            type="button"
                            className="link-button remove-cost"
                            onClick={() => removeCostItem(item.id)}
                          >
                            Ta bort
                          </button>
                        </div>
                      </>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="cost-hint">
                Lägg till poster så räknas de om till månadskostnad (år/termin/säsong delas på 12/6/4).
              </p>
            )}
            <div className="category-admin">
              <div>
                <h4>Kategorier</h4>
                <p>Gruppera dina kostnader i egna kategorier för tydligare rapporter.</p>
              </div>
              <div className="category-add">
                <input
                  type="text"
                  placeholder="Ny kategori (t.ex. Mat)"
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                />
                <button type="button" onClick={handleAddCategory} className="ghost">
                  Lägg till kategori
                </button>
              </div>
              <ul className="category-list">
                {costCategories.map((category) => {
                  const isEditing = editingCategoryId === category.id;
                  return (
                    <li key={category.id}>
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            value={editingCategoryName}
                            onChange={(event) => setEditingCategoryName(event.target.value)}
                          />
                          <div className="category-actions">
                            <button type="button" className="ghost" onClick={saveEditCategory}>
                              Spara
                            </button>
                            <button type="button" className="link-button" onClick={cancelEditCategory}>
                              Avbryt
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span>{category.name}</span>
                          <div className="category-actions">
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => startEditCategory(category)}
                            >
                              Redigera
                            </button>
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => handleRemoveCategory(category.id)}
                              disabled={costCategories.length <= 1}
                            >
                              Ta bort
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
          <section className="savings-section">
            <div className="extra-header">
              <div>
                <h3>Sparande</h3>
                <p>Lägg till sparmål som du vill planera in i månadsbudgeten.</p>
              </div>
            </div>
            <div className="cost-inputs">
              <input
                type="text"
                name="name"
                placeholder="Sparmål (t.ex. buffert)"
                value={newSavings.name}
                onChange={handleNewSavingsChange}
              />
              <input
                type="number"
                name="amount"
                placeholder="Belopp"
                min="0"
                value={newSavings.amount}
                onChange={handleNewSavingsChange}
              />
              <select name="frequency" value={newSavings.frequency} onChange={handleNewSavingsChange}>
                <option value="monthly">per månad</option>
                <option value="quarterly">per kvartal</option>
                <option value="yearly">per år</option>
                <option value="term">per termin (≈6 mån)</option>
                <option value="season">per säsong (≈4 mån)</option>
              </select>
              <button type="button" className="ghost add-cost" onClick={addSavingsItem}>
                Lägg till sparpost
              </button>
            </div>
            {savingsItems.length > 0 ? (
              <ul className="cost-list">
                {savingsItems.map((item) => (
                  <li key={item.id} className="cost-item">
                    <div>
                      <strong>{item.name}</strong>
                      <span className="cost-meta">
                        {SEK.format(item.amount)} /{" "}
                        {item.frequency === "yearly"
                          ? "år"
                          : item.frequency === "quarterly"
                            ? "kvartal"
                            : item.frequency === "term"
                              ? "termin"
                              : item.frequency === "season"
                                ? "säsong"
                                : "månad"}
                      </span>
                    </div>
                    <div className="cost-actions">
                      <span className="cost-monthly">{SEK.format(monthlyCostValue(item))} / mån</span>
                      <button
                        type="button"
                        className="link-button remove-cost"
                        onClick={() => removeSavingsItem(item.id)}
                      >
                        Ta bort
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cost-hint">Planera sparande för att se prognosen längre ned.</p>
            )}
          </section>
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={resetForm}
              disabled={status === "loading"}
            >
              Återställ
            </button>
          </div>
          <div className="save-actions">
            <button type="button" className="ghost" onClick={handleSaveForm}>
              Spara uppgifter
            </button>
            <button
              type="button"
              className="link-button"
              onClick={handleClearSaved}
            >
              Rensa sparade
            </button>
        </div>
        {feedback && <p className="save-feedback">{feedback}</p>}
        {error && <p className="error">{error}</p>}
      </form>
      <div className="tab-nav">
        <button
          type="button"
          className={activeTab === "overview" ? "active" : ""}
          onClick={() => setActiveTab("overview")}
        >
          Budgetöversikt
        </button>
        <button
          type="button"
          className={activeTab === "results" ? "active" : ""}
          onClick={() => setActiveTab("results")}
          disabled={!result?.totals}
        >
          Resultat & scenarion
        </button>
        <button
          type="button"
          className={activeTab === "forecast" ? "active" : ""}
          onClick={() => setActiveTab("forecast")}
          disabled={!result?.totals}
        >
          Prognos & diagram
        </button>
      </div>
      <div className={`tab-panel overview-panel ${activeTab === "overview" ? "active" : ""}`}>
        {result?.totals ? (
          <section className="summary-grid-container">
            <div className="results-header">
              <div>
                <h2>Budgetöversikt</h2>
                <p>
                  Totala månadsutgifter och hur de förhåller sig till din nettolön.
                </p>
              </div>
              <span className="results-status">
                Uppdaterad kalkyl · {new Date().toLocaleTimeString("sv-SE")}
              </span>
            </div>
            <div className="summary-grid">
              <article className="summary-card primary">
                <p>Totalt att lägga undan / mån</p>
                <h3>{SEK.format(combinedMonthlyPlan)}</h3>
                <span>{PERCENT.format(totalIncomeShare ?? 0)} av nettolönen</span>
                <div className="progress">
                  <div style={{ width: `${planProgress}%` }} />
                </div>
              </article>
              <article className="summary-card">
                <p>Bolån / mån</p>
                <h3>{SEK.format(loanMonthlyTotal)}</h3>
                <span>{PERCENT.format(loanIncomeShare ?? 0)} av nettolönen</span>
                <div className="progress muted">
                  <div style={{ width: `${loanProgress}%` }} />
                </div>
              </article>
              <article className="summary-card">
                <p>Övriga kostnader / mån</p>
                <h3>{SEK.format(extraMonthlyTotal)}</h3>
                <span>{PERCENT.format(extraIncomeShare ?? 0)} av nettolönen</span>
                <div className="progress muted">
                  <div style={{ width: `${extraProgress}%` }} />
                </div>
              </article>
              <article className="summary-card">
                <p>Sparande / mån</p>
                <h3>{SEK.format(savingsMonthlyTotal)}</h3>
                <span>{PERCENT.format(savingsIncomeShare ?? 0)} av nettolönen</span>
                <div className="progress muted">
                  <div style={{ width: `${savingsProgress}%` }} />
                </div>
              </article>
              {hasPropertyValue && activeLoanPrincipal > 0 && (
                <article className="summary-card">
                  <p>Belåningsgrad</p>
                  <h3>{PERCENT.format(currentLoanToValue ?? 0)}</h3>
                  <span>Totala lån {SEK.format(activeLoanPrincipal)}</span>
                  {amortizationRequirement && (
                    <span>
                      Amorteringskrav: {amortizationRequirement.percent}% / år
                    </span>
                  )}
                  <div className="progress muted">
                    <div style={{ width: `${ltvProgress}%` }} />
                  </div>
                </article>
              )}
              <article
                className={`summary-card leftover ${
                  remainingNetIncome < 0 ? "negative" : ""
                }`}
              >
                <p>Kvar av nettolön</p>
                <h3>{SEK.format(remainingNetIncome ?? 0)}</h3>
                <span>
                  {remainingNetIncome < 0
                    ? "Saknas för att täcka allt"
                    : "Till övers efter alla kostnader"}
                </span>
                <div className="progress muted">
                  <div style={{ width: `${leftoverProgress}%` }} />
                </div>
              </article>
            </div>
            <div className="plan-callout">
              <div>
                <h3>Plan att lägga undan</h3>
                <p>
                  För att täcka alla kostnader behöver du spara{" "}
                  <strong>{SEK.format(combinedMonthlyPlan)}</strong> varje månad.
                </p>
              </div>
              <ul>
                <li>
                  <span>Bolånedel</span>
                  <strong>{SEK.format(loanMonthlyTotal)}</strong>
                </li>
                <li>
                  <span>Övriga kostnader</span>
                  <strong>{SEK.format(extraMonthlyTotal)}</strong>
                </li>
                <li>
                  <span>Sparande</span>
                  <strong>{SEK.format(savingsMonthlyTotal)}</strong>
                </li>
                <li>
                  <span>Kvar efter allt</span>
                  <strong className={remainingNetIncome < 0 ? "negative" : ""}>
                    {SEK.format(remainingNetIncome ?? 0)}
                  </strong>
                </li>
              </ul>
            </div>
            {taxAdjustmentEnabled && (
              <div className="tax-adjustment-banner">
                <p>
                  Skattejämkning aktiv: +{" "}
                  <strong>{SEK.format(interestDeductionMonthly)}</strong> netto /
                  månad.
                </p>
                <span>
                  Beräkningen använder justerad nettolön på{" "}
                  <strong>{SEK.format(incomeForPlan ?? netMonthlyIncome ?? 0)}</strong>.
                </span>
              </div>
            )}
          </section>
        ) : (
          <section className="summary-grid-container">
            <p className="placeholder">Fyll i dina uppgifter för att se översikten.</p>
          </section>
        )}
      </div>
      <div className={`tab-panel results-panel ${activeTab === "results" ? "active" : ""}`}>
        {result?.totals ? (
          <section className="results">
            <div className="results-header">
              <div>
                <h2>Detaljer & scenarion</h2>
                <p>Tydlig översikt över månadskostnader, årskostnader och scenarion.</p>
              </div>
              <button type="button" className="ghost" onClick={handleExportPdf}>
                Exportera PDF
              </button>
            </div>
            {futureScenario && (
              <div className="scenario-switcher">
                <div className="switch-buttons">
                  <button
                    type="button"
                    className={scenarioMode === "current" ? "active" : ""}
                    onClick={() => setScenarioMode("current")}
                  >
                    Nuvarande amortering
                  </button>
                  <button
                    type="button"
                    className={scenarioMode === "future" ? "active" : ""}
                    onClick={() => setScenarioMode("future")}
                  >
                    Efter amorteringskravet
                  </button>
                </div>
                {scenarioDifferenceMonthly != null && (
                  <span className="scenario-diff">
                    {isFutureView
                      ? "Skillnad mot nuvarande:"
                      : "Om amorteringskravet sänks:"}{" "}
                    <strong className={scenarioDifferenceMonthly < 0 ? "negative" : ""}>
                      {SEK.format(scenarioDifferenceMonthly)}
                    </strong>{" "}
                    / mån
                  </span>
                )}
              </div>
            )}
            <div
              className={`result-highlight-card ${
                (viewRemainingNetIncome ?? 0) < 0 ? "negative" : ""
              }`}
            >
              <div>
                <p>Status</p>
                <h3>{viewBudgetStatus ?? "–"}</h3>
                <span>{viewStatusMessage || "Vi uppdaterar statusen när kalkylen är klar."}</span>
              </div>
              <div className="result-breakdown-grid">
                <div>
                  <p>Bolån</p>
                  <strong>{SEK.format(viewLoanMonthly)}</strong>
                </div>
                <div>
                  <p>Övrigt</p>
                  <strong>{SEK.format(extraMonthlyTotal)}</strong>
                </div>
                <div>
                  <p>Totalt</p>
                  <strong>{SEK.format(viewCombinedPlan)}</strong>
                </div>
                <div>
                  <p>Kvar</p>
                  <strong>{SEK.format(viewRemainingNetIncome ?? 0)}</strong>
                </div>
              </div>
            </div>
            <div className="result-sections stacked">
              {result?.loans?.length > 0 && (
                <article className="result-card">
                  <h3>Lånedelar</h3>
                  <table className="loan-breakdown-table">
                    <thead>
                      <tr>
                        <th>Lån</th>
                        <th>Ränta / mån</th>
                        <th>Amortering / mån</th>
                        <th>Totalt / mån</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.loans.map((loan) => (
                        <tr key={loan.id}>
                          <td>{loan.name}</td>
                          <td>{SEK.format(loan.monthlyInterest)}</td>
                          <td>{SEK.format(loan.monthlyAmortization)}</td>
                          <td>{SEK.format(loan.totalMonthlyCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              )}
              <article className="result-card">
                <div className="cost-summary-header">
                  <div>
                    <h3>Kostnader per månad & år</h3>
                    <p>Alla poster sammanställda med månads- och årsvärden.</p>
                  </div>
                  <button type="button" className="ghost" onClick={handleExportCostSummary}>
                    Exportera (Excel/CSV)
                  </button>
                </div>
                {activeCostSummaryRows.length > 0 ? (
                  <table className="cost-summary-table">
                    <thead>
                      <tr>
                        <th>Kategori</th>
                        <th>kr / mån</th>
                        <th>kr / år</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeCostSummaryRows.map((row) => (
                        <tr key={row.label} className={row.isTotal ? "total" : ""}>
                          <td>{row.label}</td>
                          <td>{SEK.format(row.amount)}</td>
                          <td>{SEK.format(row.annual)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="cost-hint">Lägg till kostnader för att se tabellen.</p>
                )}
              </article>
              {sharedCostItems.length > 0 && (
                <article className="result-card">
                  <h3>Delade kostnader (barn)</h3>
                  <p className="metric-note">
                    Totalt {SEK.format(sharedMonthlyTotals.total)} / mån · din del {SEK.format(sharedMonthlyTotals.myShare)} / mån.
                  </p>
                  <table className="loan-breakdown-table">
                    <thead>
                      <tr>
                        <th>Post</th>
                        <th>Totalt (kr/mån)</th>
                        <th>Din del (kr/mån)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sharedCostItems.map((item) => (
                        <tr key={`shared-${item.id}`}>
                          <td>{item.name}</td>
                          <td>{SEK.format(monthlyCostValue(item))}</td>
                          <td>{SEK.format(effectiveMonthlyCost(item))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </article>
              )}
              <article className="result-card">
                <h3>Inkomster & andelar</h3>
                <div className="income-grid">
                  <div>
                    <span>Brutto (totalt)</span>
                    <strong>{SEK.format(incomeBreakdown.totalGross)}</strong>
                  </div>
                  <div>
                    <span>Skatt (totalt)</span>
                    <strong>{SEK.format(monthlyTaxAmount)}</strong>
                  </div>
                  <div>
                    <span>Brutolöneavdrag</span>
                    <strong>{SEK.format(normalizedCarBenefit)}</strong>
                  </div>
                  <div>
                    <span>Nettolön (utan jämkning)</span>
                    <strong>{SEK.format(netMonthlyIncome ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Nettolön (aktiv)</span>
                    <strong>{SEK.format(incomeForPlan ?? netMonthlyIncome ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Andel bolån</span>
                    <strong>{PERCENT.format(viewLoanShare ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Andel övrigt</span>
                    <strong>{PERCENT.format(viewExtraShare ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Andel sparande</span>
                    <strong>{PERCENT.format(savingsIncomeShare ?? 0)}</strong>
                  </div>
                  <div>
                    <span>Andel totalt</span>
                    <strong>{PERCENT.format(viewTotalShare ?? 0)}</strong>
                  </div>
                  {taxAdjustmentEnabled && (
                    <div>
                      <span>Jämkningspåslag</span>
                      <strong>{SEK.format(activeTaxBonus)} / mån</strong>
                    </div>
                  )}
                </div>
                {incomeBreakdown.persons.length > 0 && (
                  <ul className="income-list">
                    {incomeBreakdown.persons.map((person) => (
                      <li key={`income-${person.id}`}>
                        <div>
                          <strong>{person.name || "Person"}</strong>
                          <span>{person.tableLabel}</span>
                        </div>
                        <div>
                          <span>Nettolön</span>
                          <strong>{SEK.format(person.net)}</strong>
                          <span className="metric-note">
                            Skatt {SEK.format(person.tax)} / mån · Brutto {SEK.format(person.gross)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
              {rateScenarioSummary && (
                <article className="result-card rate-scenario-card">
                  <div className="rate-scenario-header">
                    <div>
                      <h3>Räntescenario</h3>
                      <p>
                        Simulerar rörlig ränta ±{rateScenarioSummary.delta.toFixed(2)} %-enheter för{" "}
                        {SEK.format(rateScenarioSummary.variableAmount)} av skulden.
                      </p>
                    </div>
                    <label>
                      <span>Förändring (± %-enheter)</span>
                      <input
                        type="range"
                        min="0"
                        max="3"
                        step="0.25"
                        value={rateScenarioDelta}
                        onChange={(event) => setRateScenarioDelta(Number(event.target.value))}
                      />
                      <strong>{rateScenarioDelta.toFixed(2)}%</strong>
                    </label>
                  </div>
                  <div className="rate-scenario-results">
                    <div>
                      <p>Rörlig -{rateScenarioSummary.delta.toFixed(2)}%</p>
                      <strong>{SEK.format(rateScenarioSummary.decrease.total)}</strong>
                      <span>Skillnad {formatCurrencyDiff(rateScenarioSummary.decrease.diff)}</span>
                    </div>
                    <div>
                      <p>Rörlig +{rateScenarioSummary.delta.toFixed(2)}%</p>
                      <strong>{SEK.format(rateScenarioSummary.increase.total)}</strong>
                      <span>Skillnad {formatCurrencyDiff(rateScenarioSummary.increase.diff)}</span>
                    </div>
                  </div>
                  <p className="metric-note">
                    Bundna lån: {SEK.format(rateScenarioSummary.fixedAmount)} · Rörliga lån:{" "}
                    {SEK.format(rateScenarioSummary.variableAmount)}
                  </p>
                </article>
              )}
              <article className="result-card">
                <h3>Månadsdetaljer</h3>
                <dl className="detail-list">
                  <div>
                    <dt>Månadsränta</dt>
                    <dd>{SEK.format(result?.totals?.monthlyInterest ?? 0)}</dd>
                  </div>
                  <div>
                    <dt>Månadsamortering</dt>
                    <dd>
                      {SEK.format(viewMonthlyAmortization)} ({viewAmortizationPercent}% / år)
                    </dd>
                  </div>
                  <div>
                    <dt>Total bolånekostnad</dt>
                    <dd>{SEK.format(viewLoanMonthly)}</dd>
                  </div>
                  <div>
                    <dt>Totalt att spara</dt>
                    <dd>{SEK.format(viewCombinedPlan)}</dd>
                  </div>
                </dl>
              </article>
            </div>
              <div className="scenario-grid">
                <article className="scenario-card compact">
                  <h3>Övriga kostnader</h3>
                {hasExtraCosts ? (
                  <ul className="cost-breakdown">
                    {costItems.map((item) => (
                      <li key={item.id}>
                        <span>{item.name}</span>
                        <strong>{SEK.format(effectiveMonthlyCost(item))} / mån</strong>
                        {(item.frequency === "yearly" ||
                          item.frequency === "quarterly" ||
                          item.frequency === "term") && (
                          <span className="metric-note inline">
                            {SEK.format(item.amount)} /{" "}
                            {item.frequency === "yearly"
                              ? "år"
                              : item.frequency === "quarterly"
                                ? "kvartal"
                                : "termin"}
                          </span>
                        )}
                        {item.shareWithEx && <span className="metric-note inline">Din del (50%)</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cost-hint">Lägg till poster ovan för att inkludera dem i kalkylen.</p>
                )}
                {sharedCostItems.length > 0 && (
                  <p className="metric-note">
                    Gemensamma kostnader: {SEK.format(sharedMonthlyTotals.total)} / mån totalt ·{" "}
                    {SEK.format(sharedMonthlyTotals.myShare)} din del.
                  </p>
                )}
                {electricityTotals.monthlyCost > 0 && (
                  <div className="electricity-detail">
                    <p>Elförbrukning</p>
                    <strong>
                      {NUMBER.format(electricityTotals.monthlyKwh || 0)} kWh / mån · {electricity.price || 0} kr/kWh = {SEK.format(electricityTotals.monthlyCost)} / mån
                    </strong>
                    <span className="metric-note inline">
                      {NUMBER.format(electricityTotals.annualKwh || 0)} kWh per år
                    </span>
                  </div>
                )}
              </article>
              <article className="scenario-card compact">
                <h3>Sparande</h3>
                {savingsItems.length > 0 ? (
                  <ul className="cost-breakdown">
                    {savingsItems.map((item) => (
                      <li key={item.id}>
                        <span>{item.name}</span>
                        <strong>{SEK.format(monthlyCostValue(item))} / mån</strong>
                        {(item.frequency === "yearly" ||
                          item.frequency === "quarterly" ||
                          item.frequency === "term") && (
                          <span className="metric-note inline">
                            {SEK.format(item.amount)} /{" "}
                            {item.frequency === "yearly"
                              ? "år"
                              : item.frequency === "quarterly"
                                ? "kvartal"
                                : "termin"}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="cost-hint">Lägg till sparposter för att följa dem i prognosen.</p>
                )}
                <p className="scenario-meta">
                  Totalt sparande just nu: <strong>{SEK.format(savingsMonthlyTotal)}</strong> / mån
                </p>
              </article>
              {futureScenario && (
                <article className="scenario-card">
                  <h3>Scenario efter amorteringskrav</h3>
                  <p className="scenario-meta">
                    Amortering {futureScenario.percentValue}% av lånet {usingAutoFuturePercent ? "(automatiskt max 1 %-enhet lägre, minst 1 %)" : "(egen inmatning)"}
                  </p>
                  <div className="scenario-values">
                    <div>
                      <span>Bolån / mån</span>
                      <strong>{SEK.format(futureScenario.futureTotalMonthlyCost)}</strong>
                    </div>
                    <div>
                      <span>Månadsamortering</span>
                      <strong>{SEK.format(futureScenario.futureMonthlyAmortization)}</strong>
                    </div>
                    <div>
                      <span>Totalt inkl. övriga kostnader</span>
                      <strong>{SEK.format(futureScenario.futureCombinedPlan)}</strong>
                    </div>
                    <div>
                      <span>Andel av nettolön</span>
                      <strong>{PERCENT.format(clampShare(futureScenario.futureShare))}</strong>
                    </div>
                  </div>
                  <p>
                    Kvar av nettolönen i detta scenario:{" "}
                    <strong className={futureScenario.futureLeftover < 0 ? "negative" : ""}>
                      {SEK.format(futureScenario.futureLeftover)}
                    </strong>
                    .
                  </p>
                  {scenarioDifferenceMonthly != null && (
                    <p className="scenario-meta">
                      Skillnad mot nuvarande plan:{" "}
                      <strong className={scenarioDifferenceMonthly < 0 ? "negative" : ""}>
                        {SEK.format(scenarioDifferenceMonthly)}
                      </strong>{" "}
                      / mån
                    </p>
                  )}
                </article>
              )}
            </div>
            <p className="result-summary">
              {isFutureView ? "Efter amorteringskravet" : "Med nuvarande amortering"} behöver du lägga undan{" "}
              <strong>{SEK.format(viewCombinedPlan)}</strong> per månad. Det innebär att{" "}
              <strong>{SEK.format(viewLoanMonthly)}</strong> går till bolånet,{" "}
              <strong>{SEK.format(extraMonthlyTotal)}</strong> till övriga kostnader och{" "}
              <strong>{SEK.format(savingsMonthlyTotal)}</strong> till sparande. Din nettolön
              {taxAdjustmentEnabled ? " (inkl. skattejämkning)" : ""} på{" "}
              <strong>{SEK.format(incomeForPlan ?? netMonthlyIncome ?? 0)}</strong> räcker till{" "}
              <strong>{PERCENT.format(viewTotalShare ?? 0)}</strong> av kostnaderna och lämnar{" "}
              <strong className={(viewRemainingNetIncome ?? 0) < 0 ? "negative" : ""}>
                {SEK.format(viewRemainingNetIncome ?? 0)}
              </strong>{" "}
              {(viewRemainingNetIncome ?? 0) < 0 ? "i underskott" : "i överskott"}.
              {isFutureView && scenarioDifferenceMonthly != null && (
                <>
                  {" "}
                  {scenarioDifferenceDirection === "oförändrat" ? (
                    "Det är oförändrat jämfört med idag."
                  ) : (
                    <>
                      Det är {scenarioDifferenceDirection} än idag (
                      <strong className={scenarioDifferenceMonthly < 0 ? "negative" : ""}>
                        {SEK.format(scenarioDifferenceAbs ?? 0)}
                      </strong>{" "}
                      / mån).
                    </>
                  )}
                </>
              )}
              {taxAdjustmentEnabled && (
                <>
                  {" "}
                  Skattejämkningen bidrar med <strong>{SEK.format(activeTaxBonus)}</strong> extra per månad.
                </>
              )}
            </p>
          </section>
        ) : (
          <section className="results">
            <p className="placeholder">Fyll i dina uppgifter för att se resultat och scenarion.</p>
          </section>
        )}
      </div>
      <div className={`tab-panel forecast-panel ${activeTab === "forecast" ? "active" : ""}`}>
        <section className="forecast-panel-content">
          {result?.totals ? (
            <>
              <div className="results-header">
                <div>
                  <h2>Amorteringsprognos</h2>
                  <p>Se hur återstående lån minskar med nuvarande amortering (% per år).</p>
                </div>
              </div>
              <div className="forecast-controls">
                <label htmlFor="forecastYears">
                  Antal år att visa: <strong>{forecastYears}</strong>
                </label>
                <input
                  id="forecastYears"
                  type="range"
                  min="1"
                  max="40"
                  value={forecastYears}
                  onChange={handleForecastYearsChange}
                />
              </div>
            {loanForecastData.length > 1 ? (
              <>
                <div className="forecast-chart">
                    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Graf över återstående lån">
                      <defs>
                        <linearGradient id="forecastGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#93c5fd" stopOpacity="0.5" />
                          <stop offset="100%" stopColor="#bfdbfe" stopOpacity="0.1" />
                        </linearGradient>
                      </defs>
                      <g className="forecast-grid">
                        {[20, 40, 60, 80].map((y) => (
                          <line key={y} x1="0" y1={y} x2="100" y2={y} />
                        ))}
                      </g>
                      <line className="forecast-axis" x1="0" y1="0" x2="0" y2="100" />
                      <line className="forecast-axis" x1="0" y1="100" x2="100" y2="100" />
                      {forecastAreaPoints && (
                        <polygon className="forecast-area" points={forecastAreaPoints} />
                      )}
                      {forecastPolyline && (
                        <polyline className="forecast-line" points={forecastPolyline} />
                      )}
                      {forecastChartPoints.map((point) => (
                        <circle
                          key={point.year}
                          className={`forecast-point ${
                            point.year === 0
                              ? "start"
                              : point.year === forecastYears
                                ? "end"
                                : ""
                          }`}
                          cx={point.x}
                          cy={point.y}
                          r={point.year === 0 || point.year === forecastYears ? 1.4 : 0.9}
                        />
                      ))}
                      {forecastStartPoint && (
                        <text
                          className="forecast-label"
                          x={forecastStartPoint.x}
                          y={Math.max(forecastStartPoint.y - 4, 6)}
                        >
                          År {forecastStartPoint.year}: {SEK.format(forecastStartValue)}
                        </text>
                      )}
                      {forecastEndPoint && (
                        <text
                          className="forecast-label"
                          x={Math.min(forecastEndPoint.x + 2, 92)}
                          y={Math.min(forecastEndPoint.y + 6, 96)}
                        >
                          År {forecastEndPoint.year}: {SEK.format(forecastEndValue)}
                        </text>
                      )}
                    </svg>
                    <div className="chart-footer">
                      <span>År 0 · {SEK.format(forecastStartValue)}</span>
                      <span>
                        År {forecastYears} · {SEK.format(forecastEndValue)}
                      </span>
                    </div>
                  </div>
                  <table className="forecast-table">
                    <thead>
                      <tr>
                        <th>År</th>
                        <th>Återstående lån</th>
                        {hasPropertyValue && <th>Belåningsgrad</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(hasPropertyValue ? forecastLtvData : loanForecastData).map((entry) => (
                        <tr key={entry.year}>
                          <td>{entry.year}</td>
                          <td>{SEK.format(entry.remaining)}</td>
                          {hasPropertyValue && <td>{PERCENT.format(entry.ltv ?? 0)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {hasPropertyValue && forecastLtvData.length > 0 && (
                    <p className="metric-note">
                      Belåningsgrad minskar från{" "}
                      <strong>{PERCENT.format(forecastLtvData[0].ltv ?? currentLoanToValue ?? 0)}</strong> till{" "}
                      <strong>{PERCENT.format(finalForecastLtv ?? 0)}</strong>{" "}
                      efter {forecastYears} år.
                    </p>
                  )}
                </>
              ) : (
                <p className="placeholder">
                  Lägg in en amortering över 0% för att visa prognosen.
                </p>
              )}
              <div className="savings-forecast-card">
                <div className="savings-forecast-header">
                  <div>
                    <h3>Sparprognos</h3>
                    <p>Antar en försiktig avkastning på {Math.round(SavingsGrowthRate * 100)}% per år.</p>
                  </div>
                  <div className="range-control">
                    <label htmlFor="savingsYears">
                      År: <strong>{savingsForecastYears}</strong>
                    </label>
                    <input
                      id="savingsYears"
                      type="range"
                      min="1"
                      max="15"
                      value={savingsForecastYears}
                      onChange={(event) => setSavingsForecastYears(Number(event.target.value))}
                    />
                  </div>
                </div>
                {savingsMonthlyTotal > 0 ? (
                  <>
                    <p className="savings-highlight">
                      Med {SEK.format(savingsMonthlyTotal)} / mån sparas ≈{" "}
                      <strong>{SEK.format(savingsProjectedTotal)}</strong> efter {savingsForecastYears} år.
                    </p>
                    <table className="forecast-table">
                      <thead>
                        <tr>
                          <th>År</th>
                          <th>Upparbetat sparande</th>
                        </tr>
                      </thead>
                      <tbody>
                        {savingsForecastData.map((entry) => (
                          <tr key={entry.year}>
                            <td>{entry.year}</td>
                            <td>{SEK.format(Math.round(entry.balance))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p className="placeholder">Lägg till sparposter ovan för att simulera utvecklingen.</p>
                )}
              </div>
              {combinedLoanOverview && (
                <section className="loan-overview">
                  <h3>Sammanställning bolån</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Lån</th>
                        <th>Ränta / mån</th>
                        <th>Amortering / mån</th>
                        <th>Totalt / mån</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combinedLoanOverview.map((loan) => (
                        <tr key={`overview-${loan.id}`}>
                          <td>{loan.name}</td>
                          <td>{SEK.format(loan.monthlyInterest)}</td>
                          <td>{SEK.format(loan.monthlyAmortization)}</td>
                          <td>{SEK.format(loan.totalMonthlyCost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="loan-overview-summary">
                    <span>Totalt ränta / mån</span>
                    <strong>{SEK.format(result.totals.monthlyInterest)}</strong>
                    <span>Totalt amortering / mån</span>
                    <strong>{SEK.format(result.totals.monthlyAmortization)}</strong>
                  </div>
                </section>
              )}
            </>
          ) : (
            <p className="placeholder">
              Gör först en beräkning på översiktstabben för att se prognosen.
            </p>
          )}
        </section>
      </div>
      <div className="print-only">
        {result?.totals ? (
          <section className="print-report">
            <header>
              <h1>Budgetrapport</h1>
              <p>Genererad {new Date().toLocaleString("sv-SE")}</p>
            </header>
            <div className="print-stats">
              <div>
                <span>Aktiv nettolön</span>
                <strong>{SEK.format(incomeForPlan ?? netMonthlyIncome ?? 0)}</strong>
              </div>
              <div>
                <span>Bolån / mån</span>
                <strong>{SEK.format(loanMonthlyTotal)}</strong>
              </div>
              <div>
                <span>Övriga kostnader / mån</span>
                <strong>{SEK.format(extraMonthlyTotal)}</strong>
              </div>
              <div>
                <span>Sparande / mån</span>
                <strong>{SEK.format(savingsMonthlyTotal)}</strong>
              </div>
              <div>
                <span>Totalt att lägga undan</span>
                <strong>{SEK.format(combinedMonthlyPlan)}</strong>
              </div>
              <div>
                <span>Kvar av nettolön</span>
                <strong>{SEK.format(viewRemainingNetIncome ?? 0)}</strong>
              </div>
              {hasPropertyValue && (
                <>
                  <div>
                    <span>Fastighetsvärde</span>
                    <strong>{SEK.format(propertyValueNumber)}</strong>
                  </div>
                  <div>
                    <span>Belåningsgrad</span>
                    <strong>{PERCENT.format(currentLoanToValue ?? 0)}</strong>
                  </div>
                </>
              )}
            </div>
            {result.loans?.length > 0 && (
              <>
                <h2>Lånedelar</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Lån</th>
                      <th>Ränta</th>
                      <th>Amortering</th>
                      <th>Totalt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.loans.map((loan) => (
                      <tr key={loan.id}>
                        <td>{loan.name}</td>
                        <td>{SEK.format(loan.monthlyInterest)} / mån</td>
                        <td>{SEK.format(loan.monthlyAmortization)} / mån</td>
                        <td>{SEK.format(loan.totalMonthlyCost)} / mån</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {incomeBreakdown.persons.length > 0 && (
              <>
                <h2>Inkomster</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Brutto</th>
                      <th>Skatt</th>
                      <th>Nettolön</th>
                    </tr>
                  </thead>
                  <tbody>
                    {incomeBreakdown.persons.map((person) => (
                      <tr key={`print-income-${person.id}`}>
                        <td>{person.name || "Person"}</td>
                        <td>{SEK.format(person.gross)}</td>
                        <td>{SEK.format(person.tax)}</td>
                        <td>{SEK.format(person.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <h2>Kostnadssammanställning</h2>
            <table>
              <thead>
                <tr>
                  <th>Kategori</th>
                  <th>kr / mån</th>
                  <th>kr / år</th>
                </tr>
              </thead>
              <tbody>
                {costSummaryRows.map((row) => (
                  <tr key={`print-${row.label}`} className={row.isTotal ? "total" : ""}>
                    <td>{row.label}</td>
                    <td>{SEK.format(row.amount)}</td>
                    <td>{SEK.format(row.annual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sharedCostItems.length > 0 && (
              <>
                <h2>Delade kostnader</h2>
                <p>
                  Totalt {SEK.format(sharedMonthlyTotals.total)} / mån, din del{" "}
                  {SEK.format(sharedMonthlyTotals.myShare)} / mån.
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Post</th>
                      <th>Totalt</th>
                      <th>Din del</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sharedCostItems.map((item) => (
                      <tr key={`print-shared-${item.id}`}>
                        <td>{item.name}</td>
                        <td>{SEK.format(monthlyCostValue(item))} / mån</td>
                        <td>{SEK.format(effectiveMonthlyCost(item))} / mån</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <h2>Prognos</h2>
            <p>
              Med nuvarande amortering förväntas lånet minska från{" "}
              {SEK.format(forecastStartValue)} till {SEK.format(forecastEndValue)} på{" "}
              {forecastYears} år. Sparandet når{" "}
              {SEK.format(savingsProjectedTotal)} efter {savingsForecastYears} år.
              {hasPropertyValue && (
                <>
                  {" "}
                  Belåningsgraden går från {PERCENT.format(currentLoanToValue ?? 0)} till{" "}
                  {PERCENT.format(finalForecastLtv ?? 0)}.
                </>
              )}
            </p>
          </section>
        ) : (
          <section className="print-report">
            <p>Ingen rapport kan visas förrän du gjort en beräkning.</p>
          </section>
        )}
      </div>
    </main>
    </div>
  );
}

export default App;
