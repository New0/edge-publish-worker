/**
 * Prices and the buy script, written into a page as it is served.
 *
 * docs/STRIPE-COMMERCE.md §5. The page a visitor gets shows Stripe's current
 * price, read from the price cache the webhook keeps true — not a price typed
 * into WordPress, and not one frozen into the build. So the displayed price
 * cannot drift from the charged one for longer than the cache's TTL, and a
 * price change needs no republish at all.
 *
 * The markup contract is written by the companion plugin — Buy::markup in
 * packages/wordpress/edge-publish/includes/class-buy.php, shared by the Buy
 * block and the `[edge_buy]` shortcode:
 *
 *     <div class="ews-buy" data-ews-buy="ID" data-ews-msg-…="…">
 *       <span class="ews-buy__price" data-ews-price-for="ID"></span>
 *       <button type="button" class="ews-buy__button" data-ews-buy-button="ID">…</button>
 *       <p class="ews-buy__status" role="status" data-ews-buy-status></p>
 *     </div>
 *
 * ID is a Stripe price id (`price_…`, the shortcode) or a product id
 * (`prod_…` or the mirror's `ews_<site>_<post>`, the Buy block); the prefix
 * says which. A product shows, and sells, its default price at the moment of
 * reading, so a new price needs no republish.
 *
 * Plain string work, no HTMLRewriter — the convention the product follows, so
 * the same function runs in the Worker and under Node in the tests. The
 * attributes it matches are ones only that shortcode writes.
 */

import type { PriceView } from './stripe.js';
import { formatPrice } from './stripe.js';
import { escapeHtml } from './escape.js';

/** Every price a page asks for, in order of appearance, once each. */
export function pricesOnPage(html: string): string[] {
  return [...new Set([...html.matchAll(/data-ews-buy="(price_[A-Za-z0-9]{8,64})"/g)].map((m) => m[1]))];
}

/** Every product a page asks for — the same, for product-keyed buttons. The pattern is isProductId's. */
export function productsOnPage(html: string): string[] {
  return [...new Set([...html.matchAll(/data-ews-buy="(prod_[A-Za-z0-9]{8,64}|ews_[a-z0-9_]{1,120})"/g)].map((m) => m[1]))];
}

/** The page's language, for formatting: `<html lang="fr-FR">` → `fr-FR`. */
export function pageLocale(html: string): string {
  return /<html[^>]*\slang="([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)"/i.exec(html)?.[1] ?? 'en';
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The client half, inline: a click posts the button's id to /api/checkout —
 * as `price` or `product`, by its prefix — and follows the Stripe URL it gets
 * back. The copy it shows comes from the
 * block's own data attributes, which WordPress wrote in the site's language.
 */
export const BUY_SCRIPT = `<script id="ews-buy-script">(function(){
function status(box,key){var el=box.querySelector('[data-ews-buy-status]');if(el)el.textContent=box.getAttribute('data-ews-msg-'+key)||'';}
var outcome=new URLSearchParams(location.search).get('checkout');
if(outcome==='success'||outcome==='cancelled'){document.querySelectorAll('[data-ews-buy]').forEach(function(b){status(b,outcome);});}
document.addEventListener('click',function(e){
var button=e.target.closest&&e.target.closest('[data-ews-buy-button]');if(!button||button.disabled)return;
var box=button.closest('[data-ews-buy]');button.disabled=true;status(box,'wait');
var id=button.getAttribute('data-ews-buy-button');var item=id.indexOf('price_')===0?{price:id,quantity:1}:{product:id,quantity:1};
fetch('/api/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({items:[item],return_path:location.pathname})})
.then(function(r){return r.text().then(function(t){var d={};try{d=JSON.parse(t)}catch(_){}return {ok:r.ok,d:d};});})
.then(function(res){if(res.ok&&res.d.url){location.assign(res.d.url);return;}button.disabled=false;status(box,'error');})
.catch(function(){button.disabled=false;status(box,'error');});
});})();</script>`;

/**
 * Fill in each price, mark what cannot be bought, add the script once.
 *
 * `views` is keyed by whatever the buttons name — price ids and product ids
 * together; the middleware resolves each kind and merges them. A price or
 * product the cache and Stripe could not resolve, or one that is not sellable —
 * inactive, archived, another site's, a product with no default price — leaves
 * the price empty and the button disabled. The page still renders: Stripe being down must not take
 * a page down with it.
 */
export function renderCommerce(html: string, views: Map<string, PriceView>): string {
  const ids = [...pricesOnPage(html), ...productsOnPage(html)];
  if (!ids.length) return html;
  const locale = pageLocale(html);
  let out = html;

  for (const id of ids) {
    const view = views.get(id);
    const sellable = Boolean(view?.sellable);
    const text = sellable && view ? escapeHtml(formatPrice(view, locale)) : '';
    const quoted = escapeRegExp(id);

    // Replacer functions, never replacement strings: a formatted price is
    // `$12.00` in en-US, and in a replacement string `$12` reads as capture
    // group 1 followed by "2" — the page showed "2.00" for a $12 product.
    out = out.replace(
      new RegExp(`(<span\\b[^>]*data-ews-price-for="${quoted}"[^>]*>)[^<]*(</span>)`, 'g'),
      (_match, open: string, close: string) => open + text + close
    );
    if (!sellable) {
      out = out.replace(
        new RegExp(`<button\\b([^>]*)data-ews-buy-button="${quoted}"`, 'g'),
        (_match, attributes: string) => `<button disabled aria-disabled="true"${attributes}data-ews-buy-button="${id}"`
      );
    }
  }

  if (!out.includes('id="ews-buy-script"')) {
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${BUY_SCRIPT}</body>`) : out + BUY_SCRIPT;
  }
  return out;
}
