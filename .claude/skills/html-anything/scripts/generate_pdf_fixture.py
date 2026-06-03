#!/usr/bin/env python3
"""Generate examples/pdf/input.pdf — a synthetic, anonymized 'long report'
fixture for html-anything.

The content is invented (no real customer/internal data). It mimics a
mid-size strategy/research report: exec summary, dated section structure,
data tables, claims worth extracting, quote-worthy lines, a glossary, and
a references list — i.e. the shapes the PDF prompt is supposed to surface.

Run:  python3 scripts/generate_pdf_fixture.py
Output: examples/pdf/input.pdf
"""
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    PageBreak,
    Table,
    TableStyle,
)


OUT = Path(__file__).resolve().parent.parent / "examples" / "pdf" / "input.pdf"


def styles():
    s = getSampleStyleSheet()
    s.add(ParagraphStyle(name="H1", parent=s["Heading1"], fontSize=20, leading=24, spaceAfter=12))
    s.add(ParagraphStyle(name="H2", parent=s["Heading2"], fontSize=14, leading=18, spaceBefore=14, spaceAfter=6))
    s.add(ParagraphStyle(name="H3", parent=s["Heading3"], fontSize=11, leading=14, spaceBefore=10, spaceAfter=4))
    s.add(ParagraphStyle(name="Body", parent=s["BodyText"], fontSize=10.5, leading=15, spaceAfter=8))
    s.add(ParagraphStyle(name="Quote", parent=s["BodyText"], fontSize=10.5, leading=15,
                         leftIndent=18, rightIndent=18, italic=1, textColor=colors.grey, spaceAfter=10))
    s.add(ParagraphStyle(name="Cap", parent=s["BodyText"], fontSize=9, leading=12, textColor=colors.grey, spaceAfter=10))
    return s


def p(text, style):
    return Paragraph(text, style)


def build():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(OUT), pagesize=LETTER,
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
        topMargin=0.9 * inch, bottomMargin=0.9 * inch,
        title="The State of Mid-Market Battery Storage — 2026 Outlook",
        author="Clockless Research (synthetic fixture)",
    )
    s = styles()
    story = []

    # --- Cover ---
    story += [
        p("The State of Mid-Market Battery Storage", s["H1"]),
        p("2026 Outlook — Synthetic Fixture", s["H2"]),
        p(
            "A 32-page sector outlook prepared for portfolio operators. "
            "All companies, projects, deal sizes, and individuals named in "
            "this document are <b>fictional</b> and exist only to give the "
            "html-anything PDF prompt a realistic shape to work against.",
            s["Cap"],
        ),
        Spacer(1, 0.5 * inch),
        p("Prepared by Clockless Research · April 2026", s["Cap"]),
        PageBreak(),
    ]

    # --- Executive summary ---
    story += [
        p("Executive Summary", s["H1"]),
        p(
            "Mid-market behind-the-meter battery storage moved from a "
            "policy-dependent niche to a <b>capex-positive default</b> in 2025. "
            "On every project we modelled across the synthetic 47-site portfolio, "
            "front-of-meter pricing alone justified a four-hour battery; behind-the-meter "
            "demand-charge avoidance pushed simple payback inside seven years on 38 of 47 sites.",
            s["Body"],
        ),
        p(
            "The structural change is <b>not</b> price decline of LFP cells, which has "
            "decelerated to 6.4% YoY. It is the collapse of soft costs — interconnection "
            "engineering, permitting, and commissioning — driven by software tooling that "
            "is now deployed at three of the four developers we surveyed.",
            s["Body"],
        ),
        p(
            "We expect the mid-market segment to grow from 2.1 GWh of synthetic deployments "
            "in 2025 to 7.8 GWh by 2028, with the median project size declining from 1.9 MWh "
            "to 1.1 MWh as the developer ecosystem moves down-market.",
            s["Body"],
        ),
        p("Three findings drive the rest of this report:", s["Body"]),
        p(
            "<b>1.</b> Soft costs now dominate; cell price is a second-order lever. "
            "<b>2.</b> The bottleneck is utility interconnection queues, not capital. "
            "<b>3.</b> Operator software (DERMS) is the highest-margin layer and the most contested.",
            s["Body"],
        ),
        Spacer(1, 0.2 * inch),
        p(
            "&ldquo;The cheapest electron in 2026 is one that didn&rsquo;t have to cross "
            "an interconnection.&rdquo;",
            s["Quote"],
        ),
        PageBreak(),
    ]

    # --- Section 1: Market structure ---
    story += [
        p("1. Market Structure", s["H1"]),
        p(
            "We define <b>mid-market</b> as projects between 250 kWh and 5 MWh of "
            "useable energy capacity, sited behind a commercial or industrial meter "
            "or in front of a distribution feeder serving 50&ndash;5,000 customers. "
            "This is the segment that historically had no native developer pool — "
            "too small for utility-scale shops, too large for residential installers.",
            s["Body"],
        ),
        p("1.1 Synthetic Portfolio Snapshot", s["H2"]),
        p(
            "The 47 fictional sites profiled in this report are distributed across nine "
            "U.S. states. Project sizes range from 480 kWh to 4.6 MWh. The table below "
            "summarises by state.",
            s["Body"],
        ),
        _table(
            ["State", "Sites", "Capacity (MWh)", "Median size (MWh)", "Median IRR"],
            [
                ["California (synth.)", "12", "21.4", "1.6", "14.2%"],
                ["Texas (synth.)", "9", "16.8", "1.9", "13.7%"],
                ["New York (synth.)", "6", "8.1", "1.3", "11.4%"],
                ["Massachusetts (synth.)", "5", "5.4", "1.0", "10.2%"],
                ["Illinois (synth.)", "4", "3.9", "0.9", "9.6%"],
                ["Other (synth.)", "11", "9.7", "0.8", "9.1%"],
                ["Portfolio total", "47", "65.3", "1.1", "12.3%"],
            ],
        ),
        p("1.2 Developer Concentration", s["H2"]),
        p(
            "Four fictional developers — <b>Halcyon Grid</b>, <b>Fieldline Energy</b>, "
            "<b>Mesa Pulse</b>, and <b>Bluemark Storage</b> — accounted for 71% of the "
            "synthetic 2025 deployment volume. Concentration is rising: in 2023 the same "
            "four held 49% share. We expect this to inflect downward in 2027 as the "
            "permitting tooling stack matures and lowers the entry bar.",
            s["Body"],
        ),
        p(
            "&ldquo;Halcyon&rsquo;s real moat isn&rsquo;t engineering, it&rsquo;s that "
            "they ship 14-day permits in jurisdictions where the average is 90.&rdquo; "
            "&mdash; synthetic operator interview, March 2026",
            s["Quote"],
        ),
        PageBreak(),
    ]

    # --- Section 2: Cost structure ---
    story += [
        p("2. Cost Structure", s["H1"]),
        p(
            "The shape of mid-market battery cost has flipped. As recently as 2022, "
            "cells were 56% of installed cost; by Q4 2025 they were 31%. The displaced "
            "share moved into engineering &amp; permitting (now 22%) and commissioning "
            "(now 14%), both of which are labour-bound and therefore software-targetable.",
            s["Body"],
        ),
        _table(
            ["Cost component", "2022 share", "2025 share", "2028E share"],
            [
                ["LFP cells", "56%", "31%", "26%"],
                ["BMS &amp; PCS", "12%", "13%", "12%"],
                ["EPC labor", "10%", "12%", "11%"],
                ["Engineering &amp; permitting", "9%", "22%", "16%"],
                ["Commissioning", "5%", "14%", "11%"],
                ["Interconnection fees", "5%", "6%", "12%"],
                ["Developer margin", "3%", "2%", "12%"],
            ],
        ),
        p("2.1 The Software-Eatable Layer", s["H2"]),
        p(
            "Engineering &amp; permitting, commissioning, and developer overhead together "
            "represent 38% of installed cost in 2025. This is the layer that is being "
            "compressed by operator software. Three of the four named developers above run "
            "an internal toolchain we collectively label DERMS-Plus: design automation, "
            "permit packet generation, commissioning checklist + telemetry, and ongoing "
            "dispatch optimisation.",
            s["Body"],
        ),
        p(
            "Across the synthetic portfolio, sites built with DERMS-Plus tooling "
            "completed permitting in <b>17 days median</b> versus <b>83 days</b> for "
            "the legacy approach. The cost differential per project averaged "
            "<b>$84,000</b>.",
            s["Body"],
        ),
        p("2.2 What is <i>not</i> being compressed", s["H2"]),
        p(
            "Interconnection fees are rising in three of the nine states profiled, "
            "driven by utility-side studies that price grid impacts more aggressively. "
            "We expect interconnection to <i>double</i> as a share of installed cost by "
            "2028 even as everything else compresses. This is the next bottleneck.",
            s["Body"],
        ),
        PageBreak(),
    ]

    # --- Section 3: Operator software ---
    story += [
        p("3. Operator Software (DERMS)", s["H1"]),
        p(
            "Distributed Energy Resource Management Systems (DERMS) sit between the "
            "battery and the market signals it responds to. In the mid-market segment, "
            "DERMS choices fall into three buckets.",
            s["Body"],
        ),
        p("3.1 Three Architectures", s["H2"]),
        p(
            "<b>Vendor-locked.</b> The battery OEM ships the dispatch logic. Reliable "
            "but slow to adapt to new market mechanisms (e.g. ERCOT&rsquo;s synthetic "
            "<i>Ancillary Tier 3</i> product, hypothetically introduced 2026). Roughly 40% "
            "of the synthetic portfolio runs on this approach.",
            s["Body"],
        ),
        p(
            "<b>Independent SaaS.</b> A third-party platform integrates with the OEM&rsquo;s "
            "API. Fastest to adapt, but introduces a contractual triangle. Roughly 35% of "
            "the synthetic portfolio.",
            s["Body"],
        ),
        p(
            "<b>Operator-built.</b> The site operator (or its developer) writes the "
            "dispatch layer. Highest margin retention, highest engineering cost. Roughly "
            "25% of the portfolio. Concentrated among the top two synthetic developers.",
            s["Body"],
        ),
        p("3.2 Where The Value Accrues", s["H2"]),
        p(
            "Across the synthetic portfolio, sites running operator-built DERMS captured "
            "<b>23% more revenue per MWh</b> versus vendor-locked, primarily because "
            "they could opportunistically arbitrage real-time prices and respond to "
            "demand-response calls without vendor mediation. The independent-SaaS bucket "
            "captured <b>17% more</b> than vendor-locked but trailed operator-built.",
            s["Body"],
        ),
        p(
            "&ldquo;Owning the dispatch logic is owning the cash flow. We give up on "
            "every other vertical integration argument before we give up on this "
            "one.&rdquo;",
            s["Quote"],
        ),
        PageBreak(),
    ]

    # --- Section 4: Risks ---
    story += [
        p("4. Risks &amp; Counter-Theses", s["H1"]),
        p("4.1 Interconnection Reform Stalls", s["H2"]),
        p(
            "FERC Order 2023 implementation across the nine modelled states is "
            "uneven; the worst-performing utility in the synthetic dataset has cleared "
            "12% of its queue 18 months in. If reform stalls, the bottleneck identified "
            "in &sect;2.2 hardens, and median IRRs across the portfolio fall "
            "<b>180&ndash;220 bps</b>.",
            s["Body"],
        ),
        p("4.2 Cell Tariff Volatility", s["H2"]),
        p(
            "Roughly 64% of the LFP cells in the synthetic portfolio originate from "
            "Asian manufacturers subject to current and pending tariff regimes. A "
            "20-percentage-point tariff shock would move installed cost up roughly "
            "<b>6.2%</b> at the project level &mdash; meaningful but not portfolio-breaking.",
            s["Body"],
        ),
        p("4.3 Insurance Capacity", s["H2"]),
        p(
            "Battery insurance markets remain thin and concentrated. In 2025 three "
            "synthetic carriers wrote 84% of the policies on the portfolio. A single "
            "high-profile thermal incident could withdraw capacity industry-wide and "
            "delay 12&ndash;18 months of new builds. We rate this the highest-leverage "
            "low-probability tail in the report.",
            s["Body"],
        ),
        p("4.4 What we may have wrong", s["H2"]),
        p(
            "Our portfolio is synthetic and may overweight well-permitted jurisdictions. "
            "Real portfolios with heavier exposure to NIMBY-heavy counties will likely "
            "see higher soft costs and longer schedules. We have not modelled the impact "
            "of distribution-system upgrades that shift cost onto the developer rather "
            "than the utility.",
            s["Body"],
        ),
        PageBreak(),
    ]

    # --- Section 5: Recommendations ---
    story += [
        p("5. Operator Recommendations", s["H1"]),
        p(
            "For mid-market portfolio operators evaluating where to allocate effort in "
            "the next 12&ndash;18 months, we recommend the following synthetic-portfolio-"
            "informed priorities:",
            s["Body"],
        ),
        p("5.1 Prioritise dispatch software ownership.", s["H2"]),
        p(
            "The 23% revenue uplift documented in &sect;3.2 is the single largest "
            "controllable variable in the model. Operators who outsource dispatch are "
            "ceding the largest margin pool in the value chain. Build, buy with broad "
            "API access, or acquire &mdash; but do not lock in.",
            s["Body"],
        ),
        p("5.2 Move down-market deliberately.", s["H2"]),
        p(
            "The unit economics now support 480&nbsp;kWh sites; the bottleneck is "
            "developer attention, not project economics. Operators with a permitting-"
            "automation toolchain are <b>structurally advantaged</b> at smaller sites.",
            s["Body"],
        ),
        p("5.3 Lock in interconnection upgrades early.", s["H2"]),
        p(
            "On the synthetic portfolio, sites whose interconnection studies completed "
            "before mid-2025 captured 41% lower fees than identical sites whose studies "
            "completed in Q4. Backlog growth means delay compounds; act ahead of the "
            "queue.",
            s["Body"],
        ),
        p("5.4 Diversify insurance.", s["H2"]),
        p(
            "Three-carrier concentration is unstable. Over the next 18 months, build "
            "relationships with at least two of the emerging European and synthetic-"
            "Lloyd&rsquo;s capacity providers identified in Annex C.",
            s["Body"],
        ),
        PageBreak(),
    ]

    # --- Glossary ---
    story += [
        p("Glossary", s["H1"]),
        p("<b>BMS</b> &mdash; Battery Management System. Electronics that monitor cells.", s["Body"]),
        p("<b>DERMS</b> &mdash; Distributed Energy Resource Management System. Dispatch + monitoring software.", s["Body"]),
        p("<b>EPC</b> &mdash; Engineering, Procurement, Construction. The on-site labour layer.", s["Body"]),
        p("<b>LFP</b> &mdash; Lithium Iron Phosphate. The dominant mid-market cell chemistry.", s["Body"]),
        p("<b>PCS</b> &mdash; Power Conversion System. The inverter between the battery and the grid.", s["Body"]),
        p("<b>FERC Order 2023</b> &mdash; U.S. federal rulemaking on interconnection queue reform.", s["Body"]),
        p("<b>Mid-market</b> &mdash; projects between 250&nbsp;kWh and 5&nbsp;MWh useable capacity.", s["Body"]),
        Spacer(1, 0.2 * inch),
        p("References", s["H1"]),
        p("All references in this synthetic fixture are fictional. They mimic the shape of real "
          "industry citations (BloombergNEF, Wood Mackenzie, EIA reports, FERC dockets) so the "
          "html-anything PDF prompt has something to extract.", s["Cap"]),
        p("[1] Synthetic Energy Outlook 2026, fictional Halcyon Grid public deck, March 2026.", s["Body"]),
        p("[2] Mock-FERC Docket ER26-118 (synthetic), interconnection queue review, January 2026.", s["Body"]),
        p("[3] Fictional ERCOT Ancillary Tier 3 design memo, synthetic, February 2026.", s["Body"]),
        p("[4] Imagined Mesa Pulse investor letter, Q4 2025 (synthetic).", s["Body"]),
        p("[5] Fabricated Wood-Mackenzie-style storage cost teardown, January 2026.", s["Body"]),
    ]

    doc.build(story)
    print(f"wrote {OUT.relative_to(OUT.parent.parent.parent)} ({OUT.stat().st_size} bytes)")


def _table(headers, rows):
    data = [headers] + rows
    style = TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9.5),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3eae5")),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("ALIGN", (1, 0), (-1, 0), "RIGHT"),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d8c8be")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#a03b00")),
        ("LINEABOVE", (0, -1), (-1, -1), 0.75, colors.HexColor("#a03b00")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#fff3ec")),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ])
    return Table(data, style=style, hAlign="LEFT")


if __name__ == "__main__":
    build()
