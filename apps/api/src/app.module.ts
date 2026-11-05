import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Db } from './common/db';
import { Clock } from './common/clock';
import { SettingsService } from './common/settings';
import { Audit } from './common/audit';
import { AllErrorsFilter } from './common/errors';
import { FakeKms } from './adapters/kms';
import { FakeGateway } from './adapters/gateway';
import { FakeKyc } from './adapters/kyc';
import { FakeEmail, FakeSms } from './adapters/messaging';
import { Storage } from './adapters/storage';
import { NotifyService } from './modules/notifications/notify.service';
import { AuthService } from './modules/auth/auth.service';
import { AuthController } from './modules/auth/auth.controller';
import { MeController } from './modules/users/me.controller';
import { KycService } from './modules/kyc/kyc.service';
import { CardsService } from './modules/cards/cards.service';
import { AccountController } from './modules/cards/cards.controller';
import { PlansService } from './modules/plans/plans.service';
import { PasswordAuthService } from './modules/auth/password.service';
import { ChainService } from './modules/chain/chain.service';
import { SellerService } from './modules/seller/seller.service';
import { SellerController } from './modules/seller/seller.controller';
import { FakeCadastre } from './adapters/cadastre';
import { EligibilityService } from './modules/lots/eligibility.service';
import { LotsService } from './modules/lots/lots.service';
import { LotsController } from './modules/lots/lots.controller';
import { DepositsService } from './modules/deposits/deposits.service';
import { BidsService } from './modules/bids/bids.service';
import { RevealService } from './modules/reveal/reveal.service';
import { DealsService } from './modules/deals/deals.service';
import { DealsController } from './modules/deals/deals.controller';
import { RiskService } from './modules/risk/risk.service';
import { AdminService } from './modules/admin/admin.service';
import { AdminController } from './modules/admin/admin.controller';
import { SchedulerService } from './modules/scheduler/scheduler.service';
import { DevController } from './modules/dev/dev.controller';
import { FilesController } from './modules/files/files.controller';

/**
 * Один модульный бэкенд (7.1). Модули разделены по папкам src/modules/*.
 * Внешние сервисы — за интерфейсами; здесь подключены фейковые адаптеры (P-1).
 * auction_type = 'type1': новые типы аукционов добавятся отдельным модулем правил.
 */
@Module({
  controllers: [AuthController, MeController, AccountController, LotsController, DealsController, AdminController, DevController, FilesController, SellerController],
  providers: [
    { provide: APP_FILTER, useClass: AllErrorsFilter },
    Db,
    Clock,
    SettingsService,
    Audit,
    FakeKms,
    FakeGateway,
    FakeKyc,
    FakeSms,
    FakeEmail,
    Storage,
    NotifyService,
    AuthService,
    KycService,
    CardsService,
    PlansService,
    PasswordAuthService,
    ChainService,
    SellerService,
    FakeCadastre,
    EligibilityService,
    LotsService,
    DepositsService,
    BidsService,
    RevealService,
    DealsService,
    RiskService,
    AdminService,
    SchedulerService,
  ],
})
export class AppModule {}
