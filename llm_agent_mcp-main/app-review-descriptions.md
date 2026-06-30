# Meta App Review — Use Case Descriptions

## Use Case 1: Marketing API Access Tier (ads_read, ads_management, business_management)

**Use case name:** Business Advertising Analytics

**Describe your app's use case:**
Shinjilge AI is a Mongolian-language business intelligence dashboard that helps 
small-to-medium businesses in Mongolia analyze their Facebook/Instagram advertising 
performance. Business owners connect their Meta ad account to view campaign KPIs, 
spend analytics, and conversion data in a unified dashboard with AI-powered insights.

**How do you plan to use this permission?**

ads_read:
- Read ad campaign, ad set, and ad-level data (name, status, budget, schedule)
- Read advertising insights metrics (impressions, reach, clicks, spend, CTR, CPC, CPM, 
  frequency, conversions, ROAS)
- Display KPI dashboards and generate PDF/Excel export reports

ads_management:
- Access ad account metadata (account name, currency, timezone, status)
- Required alongside ads_read for ad account API v22.0 compatibility
- Does NOT include creating, editing, or deleting ads — read-only analytics

business_management:
- Access business asset groups to discover which ad accounts and pages belong to 
  the authenticated user
- Required to list available ad accounts during initial connection

**How will user data be handled and stored?**
- Tokens are encrypted with AES-256-GCM at rest
- Data stored in user-isolated PostgreSQL schema (tenant-scoped)
- No third-party data sharing
- User can disconnect and delete all data at any time
- Token auto-refreshes before expiry; if refresh fails, user re-authenticates

**Provide detailed instructions for testing:**
1. Visit https://[app-url]/login
2. Login as admin@test.com / password123
3. Click "Холбох" (Connect) under Meta Ads section
4. Authorize with a Meta test user (can be the developer's own account)
5. Click "Синхрончлах" (Sync) — the app fetches 1 campaign, 1 ad set, 1 ad
6. View dashboard with ad performance KPIs

**Is your app published?** No (development stage, currently testing with admin users)

**Does your app include a Login button?** No custom Login button. Uses email/password 
authentication separate from Meta login.

---

## Use Case 2: Page Content Analytics (pages_read_engagement, pages_show_list)

**Use case name:** Facebook Page Engagement Analytics

**Describe your app's use case:**
Business owners connect their Facebook Page to analyze post engagement and page 
performance over time. The app fetches recent page posts and their engagement metrics 
(likes, comments, shares) for content strategy analysis.

**How do you plan to use this permission?**

pages_read_engagement:
- Read page posts (caption, media, timestamps)
- Read post-level engagement (like_count, comments_count)
- Aggregate page engagement KPIs (total posts, avg likes/comments per post)

pages_show_list:
- List pages the authenticated user manages
- Required for page selection during initial OAuth connection

**How will user data be handled and stored?**
- Page data is stored in tenant-isolated PostgreSQL tables
- Data retention is tied to user account — deletion on disconnect
- Not shared with third parties

**Provide detailed instructions for testing:**
1. Complete OAuth flow from Use Case 1
2. The app auto-fetches page posts from the connected Facebook Page
3. Dashboard shows page post analytics and engagement KPIs

**Is your app published?** No

---

## Use Case 3: Instagram Business Analytics (instagram_basic, instagram_manage_insights)

**Use case name:** Instagram Media & Engagement Analytics

**Describe your app's use case:**
Business owners analyze their Instagram Business Account's media performance. The 
app fetches Instagram media (photos, videos, carousels) and their engagement metrics 
to understand content performance and audience engagement patterns.

**How do you plan to use this permission?**

instagram_basic:
- Read Instagram Business Account media (id, caption, media_type, media_url, permalink)
- Read like_count and comments_count for each media item
- Use for content performance analysis and reporting

instagram_manage_insights:
- Read Instagram media insights metrics (impressions, reach, likes, comments, saved)
- Used for aggregated KPI calculations and trend analysis
- Insights data appears in dashboard charts and export reports

**How will user data be handled and stored?**
- Instagram media data stored in tenant-isolated tables
- Insights aggregated into KPI summaries (not raw per-media details exposed to UI)
- Data deleted on user disconnect

**Provide detailed instructions for testing:**
1. Complete OAuth flow from Use Case 1
2. Page must have an Instagram Business Account linked
3. The app auto-fetches Instagram media (up to 100 most recent)
4. Dashboard displays Instagram KPIs

**Is your app published?** No

---

## Additional Notes for Submission

**App Icon:** Upload a simple square icon (1024×1024 PNG) showing the app logo.

**Privacy Policy URL:** https://[app-domain]/privacy
(Static page hosted at /privacy endpoint of the API server, or deploy 
privacy-policy.html to a static host)

**Business Verification:** Complete at business.facebook.com/settings > 
Business Verification. Required for ads_read, ads_management, business_management.

**Test User:** Add a Meta test user in App Dashboard > Roles > Test Users for 
the review team to test with.
