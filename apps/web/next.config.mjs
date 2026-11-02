/** Сайт ходит в API через тот же домен (/api/*) — cookie сессии остаются httpOnly и same-site. */
const API = process.env.API_URL || 'http://localhost:4000';
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};
