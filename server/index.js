const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const parseNumber = (value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const calculateLoanRow = ({
  id,
  name,
  loanAmount,
  annualInterestRate,
  amortizationPercent,
  rateType = "variable",
}) => {
  const monthlyRate = annualInterestRate / 100 / 12;
  const monthlyInterest = loanAmount * monthlyRate;
  const monthlyAmortization =
    (loanAmount * (amortizationPercent / 100)) / 12;
  const totalMonthlyCost = monthlyInterest + monthlyAmortization;

  return {
    id,
    name,
    loanAmount,
    annualInterestRate,
    amortizationPercent,
    monthlyInterest,
    monthlyAmortization,
    totalMonthlyCost,
    rateType,
  };
};

app.post("/api/calculate", (req, res) => {
  const income = parseNumber(req.body?.income);
  const loansInput = Array.isArray(req.body?.loans)
    ? req.body.loans
    : [];

  if (loansInput.length === 0) {
    return res.status(400).json({
      error: "Minst ett lån måste anges för att göra en kalkyl.",
    });
  }

  const parsedLoans = loansInput
    .map((loan, index) => {
      const loanAmount = parseNumber(loan?.loanAmount);
      const annualInterestRate = parseNumber(loan?.annualInterestRate);
      const amortizationPercent =
        parseNumber(loan?.amortizationPercent) ?? 2;

      if (
        loanAmount === undefined ||
        annualInterestRate === undefined ||
        amortizationPercent === undefined ||
        loanAmount <= 0 ||
        annualInterestRate < 0 ||
        amortizationPercent < 0
      ) {
        return null;
      }

      return {
        id: loan?.id ?? `loan-${index + 1}`,
        name: loan?.name ?? `Lån ${index + 1}`,
        loanAmount,
        annualInterestRate,
        amortizationPercent,
        rateType: loan?.rateType === "fixed" ? "fixed" : "variable",
      };
    })
    .filter(Boolean);

  if (parsedLoans.length === 0) {
    const fallbackLoanAmount = parseNumber(req.body?.loanAmount);
    const fallbackInterest = parseNumber(req.body?.annualInterestRate);
    const fallbackAmortization =
      parseNumber(req.body?.amortizationPercent) ?? 2;

    if (
      fallbackLoanAmount !== undefined &&
      fallbackInterest !== undefined &&
      fallbackLoanAmount > 0 &&
      fallbackInterest >= 0 &&
      fallbackAmortization >= 0
    ) {
      parsedLoans.push({
        id: "loan-1",
        name: req.body?.loanName ?? "Lån 1",
        loanAmount: fallbackLoanAmount,
        annualInterestRate: fallbackInterest,
        amortizationPercent: fallbackAmortization,
        rateType: "variable",
      });
    }
  }

  if (parsedLoans.length === 0) {
    return res.status(400).json({
      error:
        "Minst ett lån måste anges med belopp, ränta och amortering för att göra en kalkyl.",
    });
  }

  const loanResults = parsedLoans.map((loan) => calculateLoanRow(loan));
  const totals = loanResults.reduce(
    (acc, loan) => {
      acc.loanAmount += loan.loanAmount;
      acc.monthlyInterest += loan.monthlyInterest;
      acc.monthlyAmortization += loan.monthlyAmortization;
      acc.totalMonthlyCost += loan.totalMonthlyCost;
      return acc;
    },
    {
      loanAmount: 0,
      monthlyInterest: 0,
      monthlyAmortization: 0,
      totalMonthlyCost: 0,
    },
  );

  const payload = {
    income,
    loans: loanResults,
    totals,
  };

  if (income !== undefined && income > 0) {
    payload.incomeShare = totals.totalMonthlyCost / income;
  }

  return res.json(payload);
});

app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

if (process.env.NODE_ENV === "production") {
  const clientBuildPath = path.join(__dirname, "../client/dist");
  app.use(express.static(clientBuildPath));
  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(clientBuildPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
